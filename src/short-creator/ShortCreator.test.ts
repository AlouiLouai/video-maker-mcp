process.env.LOG_LEVEL = "debug";

import { test, expect, vi } from "vitest";
import fs from "fs-extra";

import { ShortCreator } from "./ShortCreator";
import { Kokoro } from "./libraries/Kokoro";
import { Remotion } from "./libraries/Remotion";
import { Whisper } from "./libraries/Whisper";
import { FFMpeg } from "./libraries/FFmpeg";
import { SoraAPI } from "./libraries/Sora";
import { Config } from "../config";
import { MusicManager } from "./music";

// mock fs-extra
vi.mock("fs-extra", async () => {
  const { createFsFromVolume, Volume } = await import("memfs");
  const vol = Volume.fromJSON({
    "/Users/gyoridavid/.ai-agents-az-video-generator/videos/video-1.mp4":
      "mock video content 1",
    "/Users/gyoridavid/.ai-agents-az-video-generator/videos/video-2.mp4":
      "mock video content 2",
    "/Users/gyoridavid/.ai-agents-az-video-generator/temp": null,
    "/Users/gyoridavid/.ai-agents-az-video-generator/libs": null,
    "/static/music/happy-music.mp3": "mock music content",
    "/static/music/sad-music.mp3": "mock music content",
    "/static/music/chill-music.mp3": "mock music content",
  });
  const memfs = createFsFromVolume(vol);

  const fsExtra = {
    ...memfs,
    // fs-extra specific methods
    ensureDirSync: vi.fn((path) => {
      try {
        memfs.mkdirSync(path, { recursive: true });
      } catch (error) {}
    }),
    removeSync: vi.fn((path) => {
      try {
        const stats = memfs.statSync(path);
        if (stats.isDirectory()) {
          // This is simplified and won't handle nested directories
          memfs.rmdirSync(path);
        } else {
          memfs.unlinkSync(path);
        }
      } catch (error) {}
    }),
    createWriteStream: vi.fn(() => ({
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    })),
    readFileSync: vi.fn((path) => {
      return memfs.readFileSync(path);
    }),
  };
  return {
    ...fsExtra,
    default: fsExtra,
  };
});

// Mock fluent-ffmpeg
vi.mock("fluent-ffmpeg", () => {
  const mockOn = vi.fn().mockReturnThis();
  const mockSave = vi.fn().mockReturnThis();
  const mockPipe = vi.fn().mockReturnThis();

  const ffmpegMock = vi.fn(() => ({
    input: vi.fn().mockReturnThis(),
    audioCodec: vi.fn().mockReturnThis(),
    audioBitrate: vi.fn().mockReturnThis(),
    audioChannels: vi.fn().mockReturnThis(),
    audioFrequency: vi.fn().mockReturnThis(),
    toFormat: vi.fn().mockReturnThis(),
    on: mockOn,
    save: mockSave,
    pipe: mockPipe,
  }));

  ffmpegMock.setFfmpegPath = vi.fn();

  return { default: ffmpegMock };
});

// mock kokoro-js
vi.mock("kokoro-js", () => {
  return {
    KokoroTTS: {
      from_pretrained: vi.fn().mockResolvedValue({
        generate: vi.fn().mockResolvedValue({
          toWav: vi.fn().mockReturnValue(new ArrayBuffer(8)),
          audio: new ArrayBuffer(8),
          sampling_rate: 44100,
        }),
      }),
    },
  };
});

// Mock https module for video download
vi.mock("https", () => {
  const originalHttps = vi.importActual("https") as any; 
  const EventEmitter = require("events");

  return {
    ...originalHttps, 
    get: vi.fn((url: string, callback?: (res: any) => void) => {
      const responseEmitter = new EventEmitter() as any; 
      responseEmitter.statusCode = 200;
      responseEmitter.pipe = vi.fn((destinationStream: any) => {
        // The fs.createWriteStream mock has an 'on' method.
        // We need to find the 'finish' handler and call it.
        if (destinationStream.on && typeof destinationStream.on === 'function') {
            const onCall = destinationStream.on.mock?.calls.find((call: any) => call[0] === 'finish');
            if (onCall && typeof onCall[1] === 'function') {
                onCall[1](); // Call the 'finish' handler
            } else {
                // If the specific mock structure is different, this might need adjustment
                // For now, assume 'finish' can be emitted if 'on' was used to register it.
                // Or, if the stream is an EventEmitter itself:
                // destinationStream.emit('finish');
            }
        }
        return destinationStream; 
      });

      if (callback) {
        callback(responseEmitter);
      }

      const requestEmitter = new EventEmitter();
      // requestEmitter.on = vi.fn().mockReturnThis(); // Use actual EventEmitter .on
      
      // Example: to simulate an error for testing this path:
      // setTimeout(() => requestEmitter.emit('error', new Error("Mock https.get error")), 0);
      
      return requestEmitter; 
    }),
  };
});

// mock remotion
vi.mock("@remotion/bundler", () => {
  return {
    bundle: vi.fn().mockResolvedValue("mocked-bundled-url"),
  };
});
vi.mock("@remotion/renderer", () => {
  return {
    renderMedia: vi.fn().mockResolvedValue(undefined),
    selectComposition: vi.fn().mockResolvedValue({
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 300,
    }),
    ensureBrowser: vi.fn().mockResolvedValue(undefined),
  };
});

// mock whisper
vi.mock("@remotion/install-whisper-cpp", () => {
  return {
    downloadWhisperModel: vi.fn().mockResolvedValue(undefined),
    installWhisperCpp: vi.fn().mockResolvedValue(undefined),
    transcribe: vi.fn().mockResolvedValue({
      transcription: [
        {
          text: "This is a mock transcription.",
          offsets: { from: 0, to: 2000 },
          tokens: [
            { text: "This", timestamp: { from: 0, to: 500 } },
            { text: " is", timestamp: { from: 500, to: 800 } },
            { text: " a", timestamp: { from: 800, to: 1000 } },
            { text: " mock", timestamp: { from: 1000, to: 1500 } },
            { text: " transcription.", timestamp: { from: 1500, to: 2000 } },
          ],
        },
      ],
    }),
  };
});

test("test me", async () => {
  const kokoro = await Kokoro.init("fp16");
  const ffmpeg = await FFMpeg.init();

  vi.spyOn(ffmpeg, "saveNormalizedAudio").mockResolvedValue("mocked-path.wav");
  vi.spyOn(ffmpeg, "saveToMp3").mockResolvedValue("mocked-path.mp3");

  const soraAPI = new SoraAPI("mock-sora-key", "https://mock.sora.endpoint/api");
  vi.spyOn(soraAPI, "generateVideo").mockResolvedValue({
    id: "sora-job-mock-video-id-1", // Or any mock ID
    url: "https://mock.sora.video/video.mp4", // Mock video URL
    width: 1080, // Or based on orientation
    height: 1920, // Or based on orientation
  });

  const config = new Config();
  const remotion = await Remotion.init(config);

  // control the render promise resolution
  let resolveRenderPromise: () => void;
  const renderPromiseMock: Promise<void> = new Promise((resolve) => {
    resolveRenderPromise = resolve;
  });
  vi.spyOn(remotion, "render").mockReturnValue(renderPromiseMock);

  const whisper = await Whisper.init(config);

  vi.spyOn(whisper, "CreateCaption").mockResolvedValue([
    { text: "This", startMs: 0, endMs: 500 },
    { text: " is", startMs: 500, endMs: 800 },
    { text: " a", startMs: 800, endMs: 1000 },
    { text: " mock", startMs: 1000, endMs: 1500 },
    { text: " transcription.", startMs: 1500, endMs: 2000 },
  ]);

  const musicManager = new MusicManager(config);

  const shortCreator = new ShortCreator(
    config,
    remotion,
    kokoro,
    whisper,
    ffmpeg,
    soraAPI,
    musicManager,
  );

  const videoId = shortCreator.addToQueue(
    [
      {
        text: "test",
        searchTerms: ["test"],
      },
    ],
    {},
  );

  // list videos while the video is being processed
  let videos = shortCreator.listAllVideos();
  expect(videos.find((v) => v.id === videoId)?.status).toBe("processing");

  // create the video file on the file system and check the status again
  fs.writeFileSync(shortCreator.getVideoPath(videoId), "mock video content");
  videos = shortCreator.listAllVideos();
  expect(videos.find((v) => v.id === videoId)?.status).toBe("processing");

  // resolve the render promise to simulate the video being processed, and check the status again
  resolveRenderPromise();
  await new Promise((resolve) => setTimeout(resolve, 100)); // let the queue process the video
  videos = shortCreator.listAllVideos();
  expect(videos.find((v) => v.id === videoId)?.status).toBe("ready");

  // check the status of the video directly
  const status = shortCreator.status(videoId);
  expect(status).toBe("ready");
});
