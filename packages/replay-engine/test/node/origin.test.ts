import { describe, expect, it } from "vitest";
import { classifyOrigin } from "../../src/index.js";

describe("classifyOrigin", () => {
  it("classifies development origins", () => {
    for (const url of [
      "http://localhost:3000/checkout",
      "http://127.0.0.1:8080/",
      "http://app.localhost/",
      "http://myapp.local/",
      "http://myapp.test/",
      "http://10.0.0.5/",
      "http://172.16.4.9/",
      "http://192.168.1.20/",
      "file:///Users/x/index.html",
    ]) {
      expect(classifyOrigin(url), url).toBe("development");
    }
  });

  it("classifies preview origins", () => {
    for (const url of [
      "https://my-app.vercel.app/",
      "https://my-app.netlify.app/",
      "https://my-app.pages.dev/",
      "https://abc.ngrok-free.app/",
      "https://deploy-preview-42.example.com/",
      "https://pr-17.example.com/",
      "https://staging.acme.com/",
      "https://preview.acme.com/",
      "https://dev.acme.com/",
      "https://test.acme.com/",
    ]) {
      expect(classifyOrigin(url), url).toBe("preview");
    }
  });

  it("classifies the cloud-IDE and tunnel hosts as preview", () => {
    // Throwaway builds: a wrong `published` here draws a drift alert on a
    // build that was never meant to last the afternoon.
    for (const url of [
      "https://acme-3000.app.github.dev/",
      "https://3000-acme-abc123.ws-eu45.gitpod.io/",
      "https://quiet-river-1234.trycloudflare.com/",
      "https://acme.loca.lt/",
      "https://laptop.tail1234.ts.net/",
      "https://abc123-00-xyz.riker.replit.dev/",
    ]) {
      expect(classifyOrigin(url), url).toBe("preview");
    }
  });

  it("classifies real production hosts as published", () => {
    for (const url of [
      "https://app.acme.com/orders",
      "https://acme.herokuapp.com/",
      "https://acme.fly.dev/",
      "https://acme.github.io/",
    ]) {
      expect(classifyOrigin(url), url).toBe("published");
    }
  });

  it("treats the reserved .test TLD as development, not the preview label", () => {
    expect(classifyOrigin("http://shop.test/")).toBe("development");
    expect(classifyOrigin("https://test.shop.com/")).toBe("preview");
  });

  it("falls back to development for anything unparseable", () => {
    // Not a tie-break — development is the class that is never checked, so an
    // origin we cannot even parse can never produce a false alert.
    expect(classifyOrigin("nonsense")).toBe("development");
  });
});
