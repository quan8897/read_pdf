import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

// Cách lấy API Key an toàn cho cả môi trường dev và production (Vercel)
const getApiKey = () => {
  // 1. Thử VITE_ prefix (Dùng cho Vercel/Vite Client)
  const viteKey = (import.meta as any).env.VITE_GEMINI_API_KEY;
  if (viteKey) return viteKey;
  
  // 2. Thử GEMINI_API_KEY (Dùng cho AI Studio)
  const geminiKey = (import.meta as any).env.GEMINI_API_KEY;
  if (geminiKey) return geminiKey;
  
  // 3. Thử process.env (Dùng cho môi trường build/Node)
  if (typeof process !== 'undefined' && process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY;
  }
  
  console.warn("Gemini API Key is missing! Check your environment variables.");
  return "";
};

const ai = new GoogleGenAI({ apiKey: getApiKey() });

export interface ExtractedInfo {
  issuingOrg: string;
  documentNumber: string;
  issueDate: string;
  title: string;
  summary: string;
  recipients: string;
  usage?: {
    promptTokens: number;
    candidatesTokens: number;
    totalTokens: number;
  };
}

export interface DocumentBoundary {
  startPage: number;
  documentNumber: string;
}

export async function detectDocumentBoundaries(base64Thumbnails: string): Promise<DocumentBoundary[]> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Thiếu API Key.");

  const model = "gemini-3-flash-preview";
  const prompt = `Bạn là một chuyên gia phân loại văn bản hành chính. 
  Tôi cung cấp cho bạn một tệp PDF chứa lưới các trang thu nhỏ (thumbnails) từ một tệp PDF quét lộn xộn.
  Nhiệm vụ của bạn:
  1. Xác định các trang bắt đầu của một văn bản mới (dấu hiệu: có Quốc hiệu "CỘNG HÒA XÃ HỘI CHU NGHĨA VIỆT NAM" và tên cơ quan ban hành).
  2. Trích xuất Số hiệu văn bản của văn bản bắt đầu tại trang đó (nếu thấy).
  
  Trả về kết quả dưới dạng JSON là một mảng các đối tượng:
  [{"startPage": số_trang_bắt_đầu_tính_từ_1, "documentNumber": "số_hiệu_văn_bản"}]`;

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        parts: [
          { text: prompt },
          { inlineData: { data: base64Thumbnails, mimeType: "application/pdf" } }
        ]
      }
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            startPage: { type: Type.NUMBER },
            documentNumber: { type: Type.STRING }
          },
          required: ["startPage", "documentNumber"]
        }
      }
    }
  });

  try {
    return JSON.parse(response.text || "[]");
  } catch (e) {
    console.error("Lỗi parse ranh giới văn bản:", e);
    return [];
  }
}

export async function* extractPdfInfoStream(base64Data: string): AsyncGenerator<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Thiếu API Key. Vui lòng cấu hình VITE_GEMINI_API_KEY trên Vercel.");
  }

  const model = "gemini-3-flash-preview";
  
  const prompt = `Bạn là một chuyên gia phân tích văn bản hành chính Việt Nam. 
  Tôi cung cấp cho bạn một hình ảnh tổng hợp chứa các phần quan trọng nhất của văn bản:
  - Phần trên cùng: Đầu trang 1 (Số hiệu, Cơ quan ban hành, Tiêu đề)
  - Phần giữa: Cuối trang áp chót (Chữ ký dự phòng)
  - Phần dưới cùng: Cuối trang cuối (Chữ ký chính, Nơi nhận)
  
  Hãy trích xuất các thông tin sau dưới dạng JSON:
  1. issuingOrg: Tên cơ quan ban hành
  2. documentNumber: Số hiệu văn bản
  3. issueDate: Ngày phát hành (định dạng DD/MM/YYYY)
  4. title: Tiêu đề văn bản
  5. summary: Tóm tắt nội dung (1 câu ngắn gọn)
  6. recipients: Danh sách nơi nhận (mỗi dòng 1 đơn vị, bắt đầu bằng "-")`;

  const responseStream = await ai.models.generateContentStream({
    model: model,
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "application/pdf",
              data: base64Data,
            },
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL }, // Tối ưu tốc độ phản hồi tối đa
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          issuingOrg: { type: Type.STRING },
          documentNumber: { type: Type.STRING },
          issueDate: { type: Type.STRING },
          title: { type: Type.STRING },
          summary: { type: Type.STRING },
          recipients: { type: Type.STRING },
        },
        required: ["issuingOrg", "documentNumber", "issueDate", "title", "summary", "recipients"],
      },
    },
  });

  let fullText = "";
  for await (const chunk of responseStream) {
    const chunkText = chunk.text;
    if (chunkText) {
      fullText += chunkText;
      
      // Nếu là chunk cuối cùng, nó sẽ chứa usageMetadata
      if (chunk.usageMetadata) {
        try {
          const parsed = JSON.parse(fullText);
          parsed.usage = {
            promptTokens: chunk.usageMetadata.promptTokenCount,
            candidatesTokens: chunk.usageMetadata.candidatesTokenCount,
            totalTokens: chunk.usageMetadata.totalTokenCount
          };
          yield JSON.stringify(parsed);
          return;
        } catch (e) {}
      }
      
      yield fullText;
    }
  }
}
