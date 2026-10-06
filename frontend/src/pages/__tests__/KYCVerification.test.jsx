import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import KYCVerification from "../KYCVerification";
import api from "../../services/api";

jest.mock("../../services/api", () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

const makeFile = (name, type, size = 1024) => {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

describe("KYCVerification submission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    api.get.mockResolvedValue({ data: { status: "not_started" } });
    api.post.mockResolvedValue({ data: { status: "pending" } });
  });

  const advanceToDocumentStep = async () => {
    // Step 1: personal info
    await userEvent.type(screen.getByLabelText(/full name/i), "Jane Doe");
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    // Step 2: ID details
    await userEvent.type(screen.getByLabelText(/id number/i), "123456789");
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
  };

  it("submits multipart/form-data with the document file and expiry date", async () => {
    render(<KYCVerification />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());

    await advanceToDocumentStep();

    const document = makeFile("id.png", "image/png");
    const selfie = makeFile("selfie.jpg", "image/jpeg");

    await userEvent.upload(screen.getByLabelText(/id document/i), document);
    await userEvent.upload(screen.getByLabelText(/selfie/i), selfie);
    await userEvent.type(
      screen.getByLabelText(/document expiry/i),
      "2030-01-01"
    );

    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());

    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe("/kyc/submit");
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("document")).toBe(document);
    expect(body.get("selfie")).toBe(selfie);
    expect(body.get("document_expiry_date")).toBe("2030-01-01");
  });

  it("rejects files that exceed the backend size limit", async () => {
    render(<KYCVerification />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());

    await advanceToDocumentStep();

    const tooBig = makeFile("big.png", "image/png", 10 * 1024 * 1024);
    await userEvent.upload(screen.getByLabelText(/id document/i), tooBig);

    expect(await screen.findByText(/too large/i)).toBeInTheDocument();
  });

  it("moves the UI to pending status after a successful submission", async () => {
    render(<KYCVerification />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());

    await advanceToDocumentStep();

    await userEvent.upload(
      screen.getByLabelText(/id document/i),
      makeFile("id.png", "image/png")
    );
    await userEvent.type(
      screen.getByLabelText(/document expiry/i),
      "2030-01-01"
    );

    await userEvent.click(screen.getByRole("button", { name: /submit/i }));

    expect(await screen.findByText(/pending/i)).toBeInTheDocument();
  });
});
