import { SoraAPI } from "./Sora";
import { OrientationEnum, Video } from "../../types/shorts";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock logger to prevent console output during tests
vi.mock("../../logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock getOrientationConfig
vi.mock("../../components/utils", () => ({
  getOrientationConfig: vi.fn((orientation) => {
    if (orientation === OrientationEnum.portrait) return { width: 1080, height: 1920 };
    if (orientation === OrientationEnum.landscape) return { width: 1920, height: 1080 };
    return { width: 1080, height: 1080 }; // Default square
  }),
}));

// Global fetch mock
global.fetch = vi.fn();

const mockApiKey = "test-sora-api-key";
const mockApiEndpoint = "https://fake.sora.endpoint.com";
const mockJobId = "test-job-id-123";
const mockVideoUrl = "https://fake.sora.endpoint.com/generated/video.mp4";

describe("SoraAPI", () => {
  let soraClient: SoraAPI;

  beforeEach(() => {
    soraClient = new SoraAPI(mockApiKey, mockApiEndpoint, 10, 100); // Short poll intervals for testing
    vi.useFakeTimers(); // Use fake timers for polling tests
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("should initialize correctly with valid parameters", () => {
      expect(soraClient).toBeInstanceOf(SoraAPI);
    });

    it("should throw error if API key is missing", () => {
      expect(() => new SoraAPI("", mockApiEndpoint)).toThrow("Sora API key not provided.");
    });

    it("should throw error if API endpoint is missing", () => {
      expect(() => new SoraAPI(mockApiKey, "")).toThrow("Sora API endpoint not provided.");
    });
  });

  describe("initiateVideoGeneration", () => {
    it("should initiate a job and return job ID from Operation-Location header", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "Operation-Location": `${mockApiEndpoint}/operations/${mockJobId}` }),
        json: async () => ({}), // Empty body if ID is in header
      });

      // Access private method for testing (common pattern, or refactor to allow testing)
      const jobId = await (soraClient as any).initiateVideoGeneration("prompt", 10, 1920, 1080);
      expect(fetch).toHaveBeenCalledWith(
        `${mockApiEndpoint}/openai/v1/video/generations/jobs?api-version=preview`,
        expect.objectContaining({ method: "POST", body: expect.any(String) })
      );
      expect(jobId).toBe(mockJobId);
    });

    it("should initiate a job and return job ID from response body if header missing", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({ id: mockJobId }),
      });
      const jobId = await (soraClient as any).initiateVideoGeneration("prompt", 10, 1920, 1080);
      expect(jobId).toBe(mockJobId);
    });

    it("should throw if API call fails", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Server Error",
        text: async () => "Internal Server Error",
      });
      await expect((soraClient as any).initiateVideoGeneration("prompt", 10, 1920, 1080))
        .rejects.toThrow(/Sora API error initiating job: 500 Server Error/);
    });

     it("should throw if no job ID is found in header or body", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({}), // No id in body
         text: async () => "{}" // For error logging
      });
      await expect((soraClient as any).initiateVideoGeneration("prompt", 10, 1920, 1080))
        .rejects.toThrow("Sora API did not return a usable job ID or polling URL.");
    });
  });

  describe("pollForJobCompletion", () => {
    const statusUrl = `${mockApiEndpoint}/openai/v1/video/generations/jobs/${mockJobId}?api-version=preview`;

    it("should poll and return data on Succeeded status", async () => {
      (fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ // First poll: Running
          ok: true,
          json: async () => ({ id: mockJobId, status: "Running" }),
        })
        .mockResolvedValueOnce({ // Second poll: Succeeded
          ok: true,
          json: async () => ({
            id: mockJobId,
            status: "Succeeded",
            result: { videos: [{ url: mockVideoUrl }] },
          }),
        });

      const promise = (soraClient as any).pollForJobCompletion(mockJobId);
      await vi.advanceTimersByTimeAsync(10); // Advance past first poll interval
      await vi.advanceTimersByTimeAsync(10); // Advance past second poll interval
      const result = await promise;

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledWith(statusUrl, expect.objectContaining({ method: "GET" }));
      expect(result.status).toBe("Succeeded");
      expect(result.result.videos[0].url).toBe(mockVideoUrl);
    });

    it("should throw on Failed status", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: mockJobId, status: "Failed", error: { message: "Generation failed" } }),
      });
      const promise = (soraClient as any).pollForJobCompletion(mockJobId);
      await vi.advanceTimersByTimeAsync(10);
      await expect(promise).rejects.toThrow(`Sora job ${mockJobId} Failed: Generation failed`);
    });

    it("should throw on polling timeout", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ // Always Running
        ok: true,
        json: async () => ({ id: mockJobId, status: "Running" }),
      });
      const promise = (soraClient as any).pollForJobCompletion(mockJobId);
      // Exceed pollTimeoutMs (100ms) with multiple small advances
      for(let i = 0; i < 15; i++) { // 15 * 10ms = 150ms > 100ms timeout
          await vi.advanceTimersByTimeAsync(10);
      }
      await expect(promise).rejects.toThrow(`Sora job polling timed out for job ID: ${mockJobId}`);
    });

    it("should throw if job Succeeded but video data is missing", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: mockJobId, status: "Succeeded", result: { videos: [] } }), // Empty videos array
      });
      const promise = (soraClient as any).pollForJobCompletion(mockJobId);
      await vi.advanceTimersByTimeAsync(10);
      await expect(promise).rejects.toThrow("Sora job succeeded but video data is missing in the response.");
    });
     it("should throw on 404 response during polling", async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Job not found",
      });
      const promise = (soraClient as any).pollForJobCompletion(mockJobId);
      await vi.advanceTimersByTimeAsync(10);
      await expect(promise).rejects.toThrow(/Sora job not found \(404\)/);
    });
  });

  describe("generateVideo", () => {
    it("should orchestrate initiation and polling to return video data", async () => {
      // Mock private methods for this higher-level test
      const initiateSpy = vi.spyOn(soraClient as any, "initiateVideoGeneration").mockResolvedValue(mockJobId);
      const pollSpy = vi.spyOn(soraClient as any, "pollForJobCompletion").mockResolvedValue({
        status: "Succeeded",
        result: { videos: [{ url: mockVideoUrl }] },
      });

      const video: Video = await soraClient.generateVideo("test prompt", 10, OrientationEnum.landscape);

      expect(initiateSpy).toHaveBeenCalledWith("test prompt", 10, 1920, 1080);
      expect(pollSpy).toHaveBeenCalledWith(mockJobId);
      expect(video).toEqual({
        id: `sora-${mockJobId}`,
        url: mockVideoUrl,
        width: 1920,
        height: 1080,
      });
    });

    it("should throw if initiation fails", async () => {
      vi.spyOn(soraClient as any, "initiateVideoGeneration").mockRejectedValue(new Error("Initiation failed"));
      await expect(soraClient.generateVideo("prompt", 5)).rejects.toThrow("Initiation failed");
    });

    it("should throw if polling fails", async () => {
      vi.spyOn(soraClient as any, "initiateVideoGeneration").mockResolvedValue(mockJobId);
      vi.spyOn(soraClient as any, "pollForJobCompletion").mockRejectedValue(new Error("Polling failed"));
      await expect(soraClient.generateVideo("prompt", 5)).rejects.toThrow("Polling failed");
    });
  });
});
