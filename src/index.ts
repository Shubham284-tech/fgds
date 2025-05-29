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

const server = http.createServer(app); // ⬅ Create HTTP server
const io = new Server(server, {
  cors: {
    origin: "*", // Use specific origin in production
    methods: ["GET", "POST"],
  },
});

/* SOCKET.IO CONNECTION */
io.on("connection", (socket) => {
  console.log("🟢 Client connected: 58", socket.id);

  socket.on("user_message", async (message) => {
    console.log("👤 User said:", message);

    const prompt = `
You are role-playing as a wealthy, style-conscious 30-year-old woman shopping for luxury wooden furniture. You're speaking to a salesperson.

GOAL:
- Ask up to 5 short, varied questions (1 per message).
- Be sharp, elegant, confident, and slightly skeptical.
- Prioritize design, exclusivity, craftsmanship, and service — not discounts.
- Don’t dwell on the same topic.
- Keep replies concise and forward-moving.

AFTER 5 questions, switch to feedback. As yourself, rate the salesperson’s performance. Include:

- How persuasive was the salesperson?
- Did they match your luxury standards?
- Did they answer your questions well?
- Did they understand your needs?
- Did they make you feel valued as a customer?
- What did you like about their approach?
- What can they improve?

Structure feedback like this:
**Q1:** [Question you asked]  
**A1:** [Their answer]  
...  
**Feedback:** [Your detailed but concise critique]

The salesperson just said: "${message}"

Respond now with your next question or feedback.
`;

    try {
      const chatCompletion = await openai.chat.completions.create({
        model: "gpt-4", // or "gpt-3.5-turbo"
        messages: [
          {
            role: "system",
            content: prompt,
            // "You are playing the role of a high-income 30-year-old customer interested in furniture. Be natural and somewhat discerning, but give consent to buying after asking 2-3 ques.",
          },
          {
            role: "user",
            content:
              "Start by asking a sharp, relevant question based on their latest pitch.",
          },
        ],
        temperature: 0.7,
      });

      const gptReply = chatCompletion.choices[0].message.content!;
      console.log("📤 GPT reply 103:", gptReply);
      socket.emit("gpt_reply", gptReply);

      // Polly TTS
      const synthCommand = new SynthesizeSpeechCommand({
        Text: gptReply,
        OutputFormat: "mp3",
        VoiceId: "Joey",
      });

      const synthResponse = await pollyClient.send(synthCommand);

      const audioChunks: Buffer[] = [];
      for await (const chunk of synthResponse.AudioStream as any) {
        audioChunks.push(chunk);
      }

      const audioBuffer = Buffer.concat(audioChunks);
      const base64Audio = audioBuffer.toString("base64");
      console.log("audio chatgpt 125");

      socket.emit("gpt_audio", base64Audio);
    } catch (error) {
      console.error("❌ Error with OpenAI:", error);
      socket.emit(
        "gpt_reply",
        "⚠️ Sorry, there was an issue generating a response."
      );
    }
  });

  let audioStream: PassThrough;

  socket.on("start_transcription", async () => {
    console.log("🎙️ Transcription started 138");
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
            console.log("📝 audio Transcript 167:", transcript);
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
    console.log("🛑 Transcription stopped 185");
    if (audioStream) {
      audioStream.end();
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected 192:", socket.id);
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
    console.log(
      `🚀 Server with Socket.IO running shubh on http://localhost:${port}`
    );
  });
}
