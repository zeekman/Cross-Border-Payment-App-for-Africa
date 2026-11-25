const request = require("supertest");
const express = require("express");
const path = require("path");
const fs = require("fs");

jest.mock("../db");
jest.mock("../middleware/auth", () => (req, res, next) => {
  req.user = { userId: "user-test-1" };
  next();
});
jest.mock("../services/stellar", () => ({}));

const db = require("../db");
const kycRouter = require("../routes/kyc");

const app = express();
app.use(express.json());
app.use("/kyc", kycRouter);

const VALID_BODY = {
  id_type: "passport",
  id_number: "AB1234567",
  date_of_birth: "1990-01-15",
};

beforeEach(() => jest.clearAllMocks());

// Clean up any files written during tests
afterAll(() => {
  const uploadDir = path.resolve(__dirname, "../../../uploads/kyc");
  if (fs.existsSync(uploadDir)) {
    fs.readdirSync(uploadDir)
      .filter((f) => f !== ".gitkeep")
      .forEach((f) => fs.unlinkSync(path.join(uploadDir, f)));
  }
});

describe("POST /kyc/submit — file validation", () => {
  test("rejects request with no file (400)", async () => {
    const res = await request(app).post("/kyc/submit").field(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/document file is required/i);
  });

  test("rejects disallowed MIME type — text/plain (400)", async () => {
    const res = await request(app)
      .post("/kyc/submit")
      .field(VALID_BODY)
      .attach("document", Buffer.from("hello"), { filename: "doc.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jpeg|png|pdf/i);
  });

  test("rejects file exceeding 10 MB (400)", async () => {
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024, "a");
    const res = await request(app)
      .post("/kyc/submit")
      .field(VALID_BODY)
      .attach("document", bigBuffer, { filename: "big.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/10 mb/i);
  });

  test("accepts valid JPEG under 10 MB and stores with UUID filename (200)", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ kyc_status: "not_submitted" }] }) // status check
      .mockResolvedValueOnce({ rows: [] }); // update

    const res = await request(app)
      .post("/kyc/submit")
      .field(VALID_BODY)
      .attach("document", Buffer.from("fake-jpeg-data"), {
        filename: "id.jpg",
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(200);
    expect(res.body.kyc_status).toBe("pending");

    // Verify the stored filename is UUID-based, not the original
    const savedFilename = db.query.mock.calls[1][1][0]; // first param of UPDATE call
    const kycData = JSON.parse(savedFilename);
    expect(kycData.document_filename).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/,
    );
    expect(kycData.document_mimetype).toBe("image/jpeg");
  });

  test("accepts valid PDF under 10 MB (200)", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ kyc_status: "not_submitted" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/kyc/submit")
      .field(VALID_BODY)
      .attach("document", Buffer.from("%PDF-fake"), {
        filename: "passport.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(200);
  });

  test("rejects missing id_type field (400)", async () => {
    const res = await request(app)
      .post("/kyc/submit")
      .field({ id_number: "AB123", date_of_birth: "1990-01-15" })
      .attach("document", Buffer.from("data"), {
        filename: "doc.jpg",
        contentType: "image/jpeg",
      });
    expect(res.status).toBe(400);
  });
});
