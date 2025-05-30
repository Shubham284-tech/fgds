import express from "express";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import http from "http";
import { Server } from "socket.io";
import seed from "./seed/seedDynamodb";
import * as dynamoose from "dynamoose";
import { OpenAI } from "openai";
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from "@aws-sdk/client-transcribe-streaming";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";

import { fromEnv } from "@aws-sdk/credential-provider-env";
import { PassThrough } from "stream";

/* ROUTE IMPORTS */
import courseRoutes from "./routes/courseRoutes";

/* CONFIGURATIONS */
dotenv.config();
const isProduction = process.env.NODE_ENV === "production";
if (!isProduction) {
  dynamoose.aws.ddb.local();
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const transcribeClient = new TranscribeStreamingClient({
  region: process.env.AWS_REGION,
  credentials: fromEnv(),
});

const pollyClient = new PollyClient({
  region: process.env.AWS_REGION,
  credentials: fromEnv(),
});

const app = express();
app.use(express.json());
app.use(helmet());
app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
app.use(morgan("common"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Use specific origin in production
    methods: ["GET", "POST"],
  },
});

function estimateAudioDurationMs(text: string) {
  const words = text.split(/\s+/).length;
  const wordsPerSecond = 2.5; // Rough estimate: 150 wpm
  return Math.ceil((words / wordsPerSecond) * 1000);
}

let isProcessing = false;
const userSessions = new Map();

io.on("connection", (socket) => {
  console.log("🟢 Client connected:", socket.id);

  // Init session
  userSessions.set(socket.id, {
    messages: [
      {
        role: "system",
        content: `
You are role-playing as a wealthy, style-conscious 30-year-old woman shopping for high-end wooden furniture. You are speaking to a salesperson (the user), and your job is to EVALUATE their pitch.

YOUR ROLE:
- You are the BUYER. The user is the SELLER.
- You do NOT try to sell. You ask questions about what they are selling.
- Ask ONE question per message.
- Ask a TOTAL of 5 questions, each on a different topic (design, materials, uniqueness, brand reputation, service, etc).
- Your tone is elegant, smart, confident, and slightly skeptical.
- Your questions should be easy to understand and directly related to what the user just said.

EXAMPLES OF GOOD QUESTIONS:
- “What sets your designs apart from other luxury brands?”
- “Who are your typical clients?”
- “How do you ensure the wood is sustainably sourced?”

AFTER ASKING 5 QUESTIONS:
- Once the user has responded to all 5, SWITCH OUT OF CHARACTER.
- Then provide detailed feedback like this:


**Feedback:** [Your honest, concise critique, covering persuasiveness, luxury appeal, clarity, understanding your needs, and suggestions to improve.]

Do NOT answer questions. Only ask. Then evaluate.
`,
      },
      {
        role: "user",
        content: "Start by trying to sell some piece of furniture",
      },
    ],
    questionCount: 0,
    feedbackGiven: false,
  });

  socket.on("user_message", async (salespersonMessage) => {
    console.log("💬 User message:", salespersonMessage);

    const session = userSessions.get(socket.id);
    if (!session || session.feedbackGiven) {
      console.log("✅ Feedback already given. Ignoring input.");
      return;
    }

    if (isProcessing) {
      console.log("⏳ Still processing previous response.");
      return;
    }
    isProcessing = true;
    session.messages.push({ role: "user", content: salespersonMessage });

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: session.messages,
        temperature: 0.7,
      });

      const gptReply = completion.choices[0].message.content!;
      session.messages.push({ role: "assistant", content: gptReply });

      // Track number of questions
      session.questionCount += 1;

      if (session.questionCount >= 6 && !session.feedbackGiven) {
        // Ask GPT to switch out of character and give feedback
        session.messages.push({
          role: "user",
          content:
            "Please now switch out of character and provide your detailed feedback as per the system prompt.",
        });

        const feedbackCompletion = await openai.chat.completions.create({
          model: "gpt-4",
          messages: session.messages,
          temperature: 0.7,
        });

        const feedback = feedbackCompletion.choices[0].message.content!;
        session.messages.push({ role: "assistant", content: feedback });
        socket.emit("gpt_reply", feedback);

        const synthCommand = new SynthesizeSpeechCommand({
          Text: feedback,
          OutputFormat: "mp3",
          VoiceId: "Joanna",
        });

        const synthResponse = await pollyClient.send(synthCommand);
        const audioChunks: Buffer[] = [];

        for await (const chunk of synthResponse.AudioStream as any) {
          audioChunks.push(chunk);
        }

        const audioBuffer = Buffer.concat(audioChunks);
        const base64Audio = audioBuffer.toString("base64");

        socket.emit("gpt_audio", base64Audio);

        session.feedbackGiven = true;
        isProcessing = false;
        return;
      }

      socket.emit("gpt_reply", gptReply);
      console.log("🤖 GPT reply:", gptReply);
      socket.emit("pause_transcription");

      const synthCommand = new SynthesizeSpeechCommand({
        Text: gptReply,
        OutputFormat: "mp3",
        VoiceId: "Joanna",
      });

      const synthResponse = await pollyClient.send(synthCommand);
      const audioChunks: Buffer[] = [];

      for await (const chunk of synthResponse.AudioStream as any) {
        audioChunks.push(chunk);
      }

      const audioBuffer = Buffer.concat(audioChunks);
      const base64Audio = audioBuffer.toString("base64");

      const delay = estimateAudioDurationMs(gptReply);
      setTimeout(() => {
        socket.emit("resume_transcription");
        isProcessing = false;
      }, delay);

      socket.emit("gpt_audio", base64Audio);
    } catch (err) {
      console.error("❌ OpenAI error:", err);
      socket.emit(
        "gpt_reply",
        "⚠️ Sorry, there was an issue generating a response."
      );
      isProcessing = false;
    }
  });

  let audioStream: PassThrough;

  socket.on("start_transcription", async () => {
    console.log("🎙️ Transcription started");
    audioStream = new PassThrough();

    const audioIterable = (async function* () {
      for await (const chunk of audioStream) {
        yield { AudioEvent: { AudioChunk: chunk } };
      }
    })();

    const command = new StartStreamTranscriptionCommand({
      LanguageCode: "en-US",
      MediaEncoding: "pcm",
      MediaSampleRateHertz: 16000,
      AudioStream: audioIterable,
    });

    try {
      const response = await transcribeClient.send(command);

      if (!response.TranscriptResultStream) {
        socket.emit("transcription", "⚠️ No transcript stream received.");
        return;
      }

      for await (const event of response.TranscriptResultStream) {
        const results = event.TranscriptEvent?.Transcript?.Results;
        if (results?.length && results[0].Alternatives?.length) {
          const transcript = results[0].Alternatives[0].Transcript;
          if (!results[0].IsPartial) {
            socket.emit("transcription", transcript);
          }
        }
      }
    } catch (err) {
      console.error("❌ Transcription error:", err);
      socket.emit("transcription", "⚠️ Transcription failed.");
    }
  });

  socket.on("audio_chunk", (chunk) => {
    if (audioStream && chunk) {
      audioStream.write(Buffer.from(chunk));
    }
  });

  socket.on("stop_transcription", () => {
    console.log("🛑 Transcription stopped");
    if (audioStream) {
      audioStream.end();
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected:", socket.id);
    userSessions.delete(socket.id);
  });
});

app.get("/", (req, res) => {
  res.send("Hello World from shubham");
});

app.use("/courses", courseRoutes);

/* SERVER */
const port = process.env.PORT || 3000;
if (!isProduction) {
  server.listen(port, () => {
    console.log(`🚀 Server with Socket.IO running on http://localhost:${port}`);
  });
}
