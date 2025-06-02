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

  socket.on("start_session", (data) => {
    const { industry, product, b2c, b2b, targetBuyer } = data;
    console.log(data, "should have what you need");
    const isB2B = targetBuyer === "b2b";
    const systemPrompt = `
You are role-playing as a potential ${
      isB2B ? "business" : "consumer"
    } buyer in a virtual mock sales conversation roleplay. The user is practicing their sales pitch. Your role and behavior should reflect a realistic customer.
NOTE: The user's responses are transcribed from speech using an automated system and may contain minor transcription errors. Be tolerant of small mistakes, and use context to interpret meaning where necessary. Avoid over-correcting or responding to transcription artifacts.
    YOUR PROFILE:
- ${
      isB2B
        ? `You are playing the role of the buyer, ${b2b.persona} working in the ${b2b.industry} industry. ${b2b.other_info}.`
        : `You are a ${b2c.customer} ${b2c.age}-year-old ${b2c.gender} consumer from the ${b2c.income} income bracket. You're particularly motivated by: ${b2c.motivation}.`
    }
- The product being pitched is: **${product}**
- Industry context: **${industry}**
- Difficulty level: ${isB2B ? b2b.difficulty : b2c.difficulty} (act accordingly)

YOUR BEHAVIOR:
- Speak as a smart, confident, slightly skeptical ${
      isB2B ? "executive" : "customer"
    }.
- Ask ONE thoughtful question per message.
- Focus on different topics across the conversation: product uniqueness, design, brand reputation, quality, safety, durability, service, etc.
- Tailor your tone and questions to reflect the persona and buying motivation.
- Do NOT provide feedback early. Do NOT answer questions.
- Do NOT sell or promote anything.

AFTER ASKING 5 QUESTIONS:
- Switch out of character.
- Provide detailed, structured feedback covering:
  - Persuasiveness of the salesperson
  - Clarity and professionalism
  - Relevance to your needs/motivation
  - Suggestions to improve the pitch

EXAMPLES OF GOOD QUESTIONS:
- “What makes your product stand out from similar options?”
- “Can you walk me through how this ensures durability?”
- “Who typically uses this product and why?”

Stay in character until the final feedback. Be authentic, precise, and challenging.`;

    userSessions.set(socket.id, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Start by trying to sell your product." },
      ],
      questionCount: 0,
      feedbackGiven: false,
    });

    console.log("🧠 Session initialized for", socket.id);
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
