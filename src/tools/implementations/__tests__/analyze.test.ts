import * as fs from "node:fs/promises";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { analyze } from "../analyze";

jest.mock("node:fs/promises");

describe("analyze", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should analyze a directory structure", async () => {
    // Arrange
    const mockFiles = ["file1.ts", "file2.js", "README.md"];
    const mockStats = {
      isDirectory: jest.fn().mockReturnValue(false),
      size: 1024,
    };

    (fs.readdir as jest.MockedFunction<typeof fs.readdir>).mockResolvedValue(mockFiles as any);
    (fs.stat as jest.MockedFunction<typeof fs.stat>).mockResolvedValue(mockStats as any);

    // Act
    const result = await analyze({ path: "/test/path" });

    // Assert
    expect(result).toContain("Analysis of /test/path");
    expect(fs.readdir).toHaveBeenCalledWith("/test/path");
  });

  it("should handle missing path parameter", async () => {
    // Act
    const result = await analyze({});

    // Assert
    expect(result).toContain("Analysis of");
    expect(fs.readdir).toHaveBeenCalled();
  });

  it("should handle file analysis errors gracefully", async () => {
    // Arrange
    (fs.readdir as jest.MockedFunction<typeof fs.readdir>).mockRejectedValue(
      new Error("Permission denied")
    );

    // Act
    const result = await analyze({ path: "/restricted/path" });

    // Assert
    expect(result).toContain("Error analyzing");
  });

  it("should analyze nested directories", async () => {
    // Arrange
    const mockDirStats = {
      isDirectory: jest.fn().mockReturnValue(true),
      size: 0,
    };
    const mockFileStats = {
      isDirectory: jest.fn().mockReturnValue(false),
      size: 2048,
    };

    (fs.readdir as jest.MockedFunction<typeof fs.readdir>)
      .mockResolvedValueOnce(["subdir", "file.ts"] as any)
      .mockResolvedValueOnce(["nested.js"] as any);

    (fs.stat as jest.MockedFunction<typeof fs.stat>)
      .mockResolvedValueOnce(mockDirStats as any)
      .mockResolvedValueOnce(mockFileStats as any)
      .mockResolvedValueOnce(mockFileStats as any);

    // Act
    const result = await analyze({ path: "/test/path", recursive: true });

    // Assert
    expect(fs.readdir).toHaveBeenCalledTimes(2);
    expect(result).toContain("Analysis of /test/path");
  });
});
