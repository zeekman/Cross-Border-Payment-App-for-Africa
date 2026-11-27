import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("../../api", () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    get: jest.fn(),
  },
}));

jest.mock("react-router-dom", () => ({
  ...jest.requireActual("react-router-dom"),
  useNavigate: () => jest.fn(),
  Link: ({ children, to }) => <a href={to}>{children}</a>,
}));

import api from "../../api";
import ForgotPassword from "../ForgotPassword";

describe("ForgotPassword page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the initial form", () => {
    render(<ForgotPassword />);
    expect(
      screen.getByRole("heading", { name: /forgot password/i })
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /send|reset|submit/i })
    ).toBeInTheDocument();
  });

  it("submits the email and shows a success message on the happy path", async () => {
    api.post.mockResolvedValueOnce({ data: { success: true } });

    render(<ForgotPassword />);
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send|reset|submit/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledTimes(1);
    });
    expect(api.post).toHaveBeenCalledWith(
      expect.stringContaining("forgot"),
      expect.objectContaining({ email: "user@example.com" })
    );

    await waitFor(() => {
      expect(
        screen.getByText(/check your email|sent|success/i)
      ).toBeInTheDocument();
    });
  });

  it("shows a validation error when the email is empty or invalid", async () => {
    render(<ForgotPassword />);
    fireEvent.click(screen.getByRole("button", { name: /send|reset|submit/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/email is required|enter.*email|valid email/i)
      ).toBeInTheDocument();
    });
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send|reset|submit/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/valid email|invalid email/i)
      ).toBeInTheDocument();
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("handles API errors gracefully", async () => {
    api.post.mockRejectedValueOnce({
      response: { data: { message: "Something went wrong" } },
    });

    render(<ForgotPassword />);
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send|reset|submit/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });
  });
});