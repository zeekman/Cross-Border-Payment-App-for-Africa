import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import KYCVerification from "../KYCVerification";
import api from "../../utils/api";

jest.mock("../../utils/api", () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

const makeFile = (name, type, size = 1024) => {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <KYCVerification />
    </MemoryRouter>
  );

describe("KYCVerification submission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    api.get.mockResolvedValue({ data: { kyc_status: "unverified" } });
    api.post.mockResolvedValue({ data: { kyc_status: "pending" } });
  });

  const advanceToDocumentStep = async () => {
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    const dob = await screen.findByLabelText(/date of birth/i);
    await userEvent.type(dob, "1990-05-01");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "passport");
    await userEvent.type(screen.getByPlaceholderText(/id number/i), "A1234567");
  };

  it("submits multipart form data with the document and expiry date", async () => {
    renderPage();
    await advanceToDocumentStep();

    const document = makeFile("id.png", "image/png");
    await userEvent.upload(screen.getByLabelText(/id document/i), document);
    await userEvent.type(screen.getByLabelText(/document expiry/i), "2030-01-01");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await userEvent.click(screen.getByRole("button", { name: /submit for verification/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe("/kyc/submit");
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("document")).toBe(document);
    expect(body.get("id_type")).toBe("passport");
    expect(body.get("document_expiry_date")).toBe("2030-01-01");
  });

  it("rejects files that exceed the backend size limit", async () => {
    renderPage();
    await advanceToDocumentStep();

    const tooBig = makeFile("big.png", "image/png", 11 * 1024 * 1024);
    await userEvent.upload(screen.getByLabelText(/id document/i), tooBig);

    expect(await screen.findByText(/10 MB or smaller/i)).toBeInTheDocument();
  });
});
