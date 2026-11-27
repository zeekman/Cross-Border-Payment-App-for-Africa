import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import RequestMoney from "../RequestMoney";
import { renderWithProviders } from "../../testUtils";

// Mock the api module used by the page.
jest.mock("../../api", () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    get: jest.fn(),
  },
}));

import api from "../../api";

const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
  ...jest.requireActual("react-router-dom"),
  useNavigate: () => mockNavigate,
}));

describe("RequestMoney page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("token", "test-token");
    localStorage.setItem("user", JSON.stringify({ id: "user-1", email: "a@b.com" }));
  });

  const fillForm = () => {
    const amountInput = screen.getByLabelText(/amount/i);
    fireEvent.change(amountInput, { target: { value: "25" } });

    const emailInput = screen.queryByLabelText(/email/i);
    if (emailInput) {
      fireEvent.change(emailInput, { target: { value: "friend@example.com" } });
    }

    const noteInput = screen.queryByLabelText(/note|memo|reason/i);
    if (noteInput) {
      fireEvent.change(noteInput, { target: { value: "Lunch" } });
    }
  };

  it("renders the initial state", () => {
    renderWithProviders(<RequestMoney />);
    expect(screen.getByRole("heading", { name: /request money/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
  });

  it("submits a money request successfully (happy path)", async () => {
    api.post.mockResolvedValueOnce({
      data: { id: "req-1", status: "pending", amount: 25 },
    });

    renderWithProviders(<RequestMoney />);
    fillForm();

    const submitButton = screen.getByRole("button", { name: /request|send request|submit/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    const [url, body, config] = api.post.mock.calls[0];
    expect(url).toMatch(/request/i);
    expect(body).toEqual(
      expect.objectContaining({ amount: expect.anything() })
    );

    // Step-up and idempotency headers must be present.
    const headers = config?.headers || {};
    const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
    expect(headerKeys).toEqual(
      expect.arrayContaining(["idempotency-key", "x-step-up-token"])
    );
    expect(headers["Idempotency-Key"] || headers["idempotency-key"]).toBeTruthy();
    expect(headers["X-Step-Up-Token"] || headers["x-step-up-token"]).toBeTruthy();

    await waitFor(() => {
      expect(
        screen.getByText(/request (sent|created|submitted)|success/i)
      ).toBeInTheDocument();
    });
  });

  it("sends exactly one request on a single submit (no double submission)", async () => {
    api.post.mockResolvedValueOnce({ data: { id: "req-2", status: "pending" } });

    renderWithProviders(<RequestMoney />);
    fillForm();

    const submitButton = screen.getByRole("button", { name: /request|send request|submit/i });
    fireEvent.click(submitButton);
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledTimes(1);
    });
  });

  it("shows validation errors for invalid input", async () => {
    renderWithProviders(<RequestMoney />);

    const submitButton = screen.getByRole("button", { name: /request|send request|submit/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(
        screen.getByText(/amount.*required|enter.*amount|valid amount/i)
      ).toBeInTheDocument();
    });

    expect(api.post).not.toHaveBeenCalled();
  });

  it("handles API errors gracefully", async () => {
    api.post.mockRejectedValueOnce({
      response: { status: 500, data: { message: "Server error" } },
    });

    renderWithProviders(<RequestMoney />);
    fillForm();

    const submitButton = screen.getByRole("button", { name: /request|send request|submit/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/server error|something went wrong|failed/i)
      ).toBeInTheDocument();
    });
  });
});