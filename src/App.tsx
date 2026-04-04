import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import JSZip from 'jszip';
import { 
  FileText, 
  Upload, 
  Loader2, 
  CheckCircle2, 
  AlertCircle, 
  Calendar, 
  Hash, 
  Type as TypeIcon,
  Info,
  X,
  Files,
  ChevronRight,
  Download,
  Building2,
  Scissors,
  FileSearch,
  ArrowRight,
  RefreshCcw,
  ExternalLink
} from 'lucide-react';
import { extractPdfInfoStream, detectDocumentBoundaries, type ExtractedInfo } from './services/geminiService';

interface FileItem {
  id: string;
  file: File;
  status: 'idle' | 'processing' | 'streaming' | 'completed' | 'error';
  result?: ExtractedInfo;
  error?: string;
  rawJson?: string;
  originalName: string;
}

export default function App() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [isProcessingAll, setIsProcessingAll] = useState(false);
  const [isSplitting, setIsSplitting] = useState(false);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const splitInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []) as File[];
    const pdfFiles = selectedFiles.filter(f => f.type === 'application/pdf');
    
    if (pdfFiles.length > 0) {
      const newFileItems: FileItem[] = pdfFiles.map(f => ({
        id: Math.random().toString(36).substr(2, 9),
        file: f,
        status: 'idle',
        originalName: f.name
      }));
      setFiles(prev => [...prev, ...newFileItems]);
    }
  };

  const handleSplitUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || file.type !== 'application/pdf') return;

    setIsSplitting(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer);
      const pageCount = pdfDoc.getPageCount();
      
      // 1. Tạo lưới ảnh thu nhỏ (chỉ lấy 30% trên cùng của mỗi trang)
      // Chúng ta sẽ tạo một trang duy nhất chứa lưới các thumbnails để tiết kiệm token tối đa.
      const thumbnailPdf = await PDFDocument.create();
      const pagesToScan = Math.min(pageCount, 25); // Quét tối đa 25 trang đầu để tìm ranh giới
      
      const thumbPage = thumbnailPdf.addPage([595, 842]); // A4
      const { width: tWidth, height: tHeight } = thumbPage.getSize();
      
      const cols = 5;
      const rows = 5;
      const cellWidth = tWidth / cols;
      const cellHeight = tHeight / rows;
      
      const embeddedPages = await thumbnailPdf.embedPages(
        await Promise.all(Array.from({length: pagesToScan}, (_, i) => pdfDoc.getPage(i)))
      );
      
      const font = await thumbnailPdf.embedFont(StandardFonts.Helvetica);
      
      for (let i = 0; i < embeddedPages.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = col * cellWidth;
        const y = tHeight - (row + 1) * cellHeight;
        
        const page = embeddedPages[i];
        const originalPage = pdfDoc.getPage(i);
        const { width: pWidth, height: pHeight } = originalPage.getSize();
        
        // Vẽ 30% trên cùng của trang vào ô lưới
        thumbPage.drawPage(page, {
          x, y, width: cellWidth, height: cellHeight,
          xScale: cellWidth / pWidth,
          yScale: (cellHeight / (pHeight * 0.3))
        });
        
        // Đánh số trang để AI dễ nhận diện
        thumbPage.drawText(`P${i+1}`, { x: x + 2, y: y + 2, size: 8, font });
      }
      
      const thumbBytes = await thumbnailPdf.save();
      const base64Thumb = btoa(new Uint8Array(thumbBytes).reduce((data, byte) => data + String.fromCharCode(byte), ''));
      
      const boundaries = await detectDocumentBoundaries(base64Thumb);
      
      if (boundaries.length === 0) {
        // Nếu không tìm thấy ranh giới, coi như 1 văn bản duy nhất
        const item: FileItem = {
          id: Math.random().toString(36).substr(2, 9),
          file: file,
          status: 'idle',
          originalName: file.name
        };
        setFiles(prev => [...prev, item]);
      } else {
        const newItems: FileItem[] = [];
        for (let i = 0; i < boundaries.length; i++) {
          const start = boundaries[i].startPage - 1;
          const end = (i < boundaries.length - 1) ? boundaries[i+1].startPage - 1 : pageCount;
          
          const subPdf = await PDFDocument.create();
          const subPages = await subPdf.copyPages(pdfDoc, Array.from({length: end - start}, (_, j) => start + j));
          subPages.forEach(p => subPdf.addPage(p));
          
          const subBytes = await subPdf.save();
          const cleanName = boundaries[i].documentNumber.replace(/[\/\\:*?"<>|]/g, '-') || `VanBan-${i+1}`;
          const subFile = new File([subBytes], `${cleanName}.pdf`, { type: 'application/pdf' });
          
          newItems.push({
            id: Math.random().toString(36).substr(2, 9),
            file: subFile,
            status: 'idle',
            originalName: file.name
          });
        }
        setFiles(prev => [...prev, ...newItems]);
      }
    } catch (err) {
      console.error("Lỗi tách file:", err);
      const msg = err instanceof Error ? err.message : "Lỗi không xác định";
      alert(`Không thể tách file: ${msg}. Vui lòng kiểm tra API Key.`);
    } finally {
      setIsSplitting(false);
      if (splitInputRef.current) splitInputRef.current.value = '';
    }
  };

  const removeFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
    if (selectedResultId === id) setSelectedResultId(null);
  };

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const processSingleFile = async (fileItem: FileItem) => {
    setFiles(prev => prev.map(f => f.id === fileItem.id ? { ...f, status: 'processing', error: undefined } : f));
    if (!selectedResultId) setSelectedResultId(fileItem.id);

    try {
      const arrayBuffer = await fileItem.file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer);
      const pageCount = pdfDoc.getPageCount();
      
      let base64Data: string;
      
      if (pageCount > 1) {
        const newPdfDoc = await PDFDocument.create();
        const compositePage = newPdfDoc.addPage([595, 842]);
        const { width: cWidth, height: cHeight } = compositePage.getSize();
        
        const [firstPage] = await newPdfDoc.embedPages([pdfDoc.getPage(0)]);
        const lastPageIndex = pageCount - 1;
        const penultimatePageIndex = pageCount >= 3 ? pageCount - 2 : -1;
        
        const p1 = pdfDoc.getPage(0);
        compositePage.drawPage(firstPage, {
          x: 0, y: cHeight * 0.6, width: cWidth, height: cHeight * 0.4,
          yScale: (cHeight * 0.4) / (p1.getHeight() * 0.4)
        });
        
        if (penultimatePageIndex !== -1) {
          const [pPage] = await newPdfDoc.embedPages([pdfDoc.getPage(penultimatePageIndex)]);
          const pP = pdfDoc.getPage(penultimatePageIndex);
          compositePage.drawPage(pPage, {
            x: 0, y: cHeight * 0.3, width: cWidth, height: cHeight * 0.3,
            yScale: (cHeight * 0.3) / (pP.getHeight() * 0.3)
          });
        }
        
        const [lPage] = await newPdfDoc.embedPages([pdfDoc.getPage(lastPageIndex)]);
        const pL = pdfDoc.getPage(lastPageIndex);
        compositePage.drawPage(lPage, {
          x: 0, y: 0, width: cWidth, height: cHeight * 0.3,
          yScale: (cHeight * 0.3) / (pL.getHeight() * 0.3)
        });
        
        const pdfBytes = await newPdfDoc.save();
        base64Data = btoa(new Uint8Array(pdfBytes).reduce((data, byte) => data + String.fromCharCode(byte), ''));
      } else {
        const pdfBytes = new Uint8Array(arrayBuffer);
        base64Data = btoa(pdfBytes.reduce((data, byte) => data + String.fromCharCode(byte), ''));
      }
      
      setFiles(prev => prev.map(f => f.id === fileItem.id ? { ...f, status: 'streaming' } : f));

      const stream = extractPdfInfoStream(base64Data);
      let lastJson = "";

      for await (const fullText of stream) {
        lastJson = fullText;
        try {
          if (fullText.trim().endsWith('}')) {
            const parsed = JSON.parse(fullText) as ExtractedInfo;
            setFiles(prev => prev.map(f => f.id === fileItem.id ? { ...f, result: parsed, rawJson: fullText } : f));
          }
        } catch (e) {}
      }

      if (!lastJson) throw new Error("Không nhận được dữ liệu từ AI.");
      const finalResult = JSON.parse(lastJson) as ExtractedInfo;
      
      // Cập nhật tên file dựa trên số văn bản quét được
      const cleanName = finalResult.documentNumber.replace(/[\/\\:*?"<>|]/g, '-') || fileItem.file.name.replace('.pdf', '');
      const renamedFile = new File([await fileItem.file.arrayBuffer()], `${cleanName}.pdf`, { type: 'application/pdf' });

      setFiles(prev => prev.map(f => f.id === fileItem.id ? { 
        ...f, 
        status: 'completed', 
        result: finalResult,
        file: renamedFile
      } : f));
    } catch (err) {
      console.error(err);
      let errorMessage = 'Lỗi xử lý';
      
      if (err instanceof Error) {
        if (err.message.includes('429') || err.message.includes('RESOURCE_EXHAUSTED')) {
          errorMessage = 'Hết hạn mức API (429). Vui lòng đợi 1 phút rồi thử lại.';
        } else {
          errorMessage = err.message;
        }
      }
      
      setFiles(prev => prev.map(f => f.id === fileItem.id ? { ...f, status: 'error', error: errorMessage } : f));
    }
  };

  const downloadPdf = (item: FileItem) => {
    const url = URL.createObjectURL(item.file);
    const link = document.createElement('a');
    link.href = url;
    link.download = item.file.name;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadJson = (item: FileItem) => {
    if (!item.result) return;
    const dataStr = JSON.stringify(item.result, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    const exportFileDefaultName = `${item.file.name.replace('.pdf', '')}_extracted.json`;
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
  };

  const processAll = async () => {
    const idleFiles = files.filter(f => f.status === 'idle' || f.status === 'error');
    if (idleFiles.length === 0) return;
    setIsProcessingAll(true);
    for (let i = 0; i < idleFiles.length; i++) {
      await processSingleFile(idleFiles[i]);
      // Thêm khoảng trễ 1.5 giây giữa các file để tránh 429 (đã tối ưu tốc độ)
      if (i < idleFiles.length - 1) await sleep(1500);
    }
    setIsProcessingAll(false);
  };

  const toggleSelectFile = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setSelectedFileIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedFileIds.size === files.length) {
      setSelectedFileIds(new Set());
    } else {
      setSelectedFileIds(new Set(files.map(f => f.id)));
    }
  };

  const processSelected = async () => {
    if (selectedFileIds.size === 0) return;
    setIsProcessingAll(true);
    const toProcess = files.filter(f => selectedFileIds.has(f.id));
    for (let i = 0; i < toProcess.length; i++) {
      await processSingleFile(toProcess[i]);
      // Thêm khoảng trễ 1.5 giây giữa các file để tránh 429 (đã tối ưu tốc độ)
      if (i < toProcess.length - 1) await sleep(1500);
    }
    setIsProcessingAll(false);
  };

  const downloadSelected = async () => {
    const toDownload = files.filter(f => selectedFileIds.size > 0 ? selectedFileIds.has(f.id) : true);
    if (toDownload.length === 0) return;

    if (toDownload.length === 1) {
      downloadPdf(toDownload[0]);
      return;
    }

    // Sử dụng ZIP để tải nhiều file cùng lúc chỉ với 1 lần xác nhận (tránh việc phải ấn OK từng file)
    const zip = new JSZip();
    toDownload.forEach(item => {
      zip.file(item.file.name, item.file);
    });

    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `VanBan_Export_${new Date().getTime()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setFiles([]);
    setSelectedResultId(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (splitInputRef.current) splitInputRef.current.value = '';
  };

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const selectedFileItem = files.find(f => f.id === selectedResultId);

  React.useEffect(() => {
    if (selectedFileItem) {
      const url = URL.createObjectURL(selectedFileItem.file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setPreviewUrl(null);
    }
  }, [selectedFileItem]);

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10 shadow-sm">
        <div className="max-w-[1600px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-xl shadow-lg shadow-blue-200">
              <Files className="text-white w-5 h-5" />
            </div>
            <h1 className="font-bold text-xl tracking-tight text-slate-800 uppercase">Hệ thống Xử lý Văn bản AI</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-sm text-slate-500 font-medium hidden md:block">
              Tách tệp • Đổi tên • Trích xuất dữ liệu
            </div>
            {files.length > 0 && (
              <button 
                onClick={reset}
                className="text-sm font-bold text-red-500 hover:bg-red-50 px-3 py-1.5 rounded-lg transition-colors"
              >
                Làm mới toàn bộ
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
          
          {/* Slot 1: Tách & Đổi tên */}
          <div className="space-y-6">
            <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 h-full min-h-[600px]">
              <div className="flex items-center gap-2 mb-6">
                <div className="bg-purple-100 p-2 rounded-lg">
                  <Scissors className="w-5 h-5 text-purple-600" />
                </div>
                <h2 className="text-lg font-black uppercase tracking-tight">1. Tách & Đổi tên</h2>
              </div>

              <div 
                onClick={() => !isSplitting && splitInputRef.current?.click()}
                className={`
                  border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all group mb-6
                  ${isSplitting ? 'bg-slate-50 border-slate-200 cursor-not-allowed' : 'border-slate-200 hover:border-purple-400 hover:bg-purple-50'}
                `}
              >
                <input 
                  type="file" 
                  ref={splitInputRef}
                  onChange={handleSplitUpload}
                  accept=".pdf"
                  className="hidden"
                />
                {isSplitting ? (
                  <div className="py-4">
                    <Loader2 className="w-10 h-10 text-purple-600 animate-spin mx-auto mb-4" />
                    <p className="font-bold text-slate-600">Đang nhận diện ranh giới...</p>
                    <p className="text-xs text-slate-400 mt-1 uppercase tracking-widest">Vui lòng chờ trong giây lát</p>
                  </div>
                ) : (
                  <>
                    <div className="bg-slate-100 p-4 rounded-full w-fit mx-auto mb-4 group-hover:bg-purple-100 transition-colors">
                      <Upload className="w-8 h-8 text-slate-400 group-hover:text-purple-600" />
                    </div>
                    <p className="font-bold text-slate-600">Tải PDF lộn xộn</p>
                    <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                      Hệ thống sẽ tự động tách thành từng văn bản riêng biệt và đổi tên theo Số hiệu.
                    </p>
                  </>
                )}
              </div>

              <div className="bg-purple-50 p-4 rounded-xl border border-purple-100">
                <div className="flex gap-3">
                  <Info className="w-5 h-5 text-purple-600 shrink-0" />
                  <p className="text-xs text-purple-800 leading-relaxed">
                    <strong>Mẹo:</strong> Bạn có thể quét 10-20 văn bản vào cùng 1 file PDF. AI sẽ tự tìm trang bắt đầu của mỗi văn bản để cắt ra.
                  </p>
                </div>
              </div>
            </section>
          </div>

          {/* Slot 2: Danh sách văn bản */}
          <div className="space-y-6">
            <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 h-full min-h-[600px] flex flex-col">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <div className="bg-blue-100 p-2 rounded-lg">
                    <Files className="w-5 h-5 text-blue-600" />
                  </div>
                  <h2 className="text-lg font-black uppercase tracking-tight">2. Danh sách ({files.length})</h2>
                </div>
                <div className="flex items-center gap-1">
                  {files.length > 0 && (
                    <button 
                      onClick={downloadSelected}
                      className="text-emerald-600 hover:bg-emerald-50 p-2 rounded-lg transition-colors"
                      title="Tải xuống các file đã chọn/tất cả"
                    >
                      <Download className="w-5 h-5" />
                    </button>
                  )}
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="text-blue-600 hover:bg-blue-50 p-2 rounded-lg transition-colors"
                    title="Thêm tệp đơn"
                  >
                    <Upload className="w-5 h-5" />
                  </button>
                </div>
              </div>
              
              <input 
                type="file" 
                ref={fileInputRef}
                onChange={handleFileChange}
                accept=".pdf"
                multiple
                className="hidden"
              />

              {files.length > 0 && (
                <div className="flex items-center justify-between mb-4 px-1">
                  <label className="flex items-center gap-2 cursor-pointer group">
                    <div 
                      onClick={toggleSelectAll}
                      className={`
                        w-4 h-4 rounded border flex items-center justify-center transition-all
                        ${selectedFileIds.size === files.length && files.length > 0
                          ? 'bg-blue-600 border-blue-600' 
                          : 'bg-white border-slate-300 group-hover:border-blue-400'}
                      `}
                    >
                      {selectedFileIds.size === files.length && files.length > 0 && <CheckCircle2 className="w-3 h-3 text-white" />}
                    </div>
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                      Chọn tất cả ({selectedFileIds.size}/{files.length})
                    </span>
                  </label>
                  {selectedFileIds.size > 0 && (
                    <button 
                      onClick={() => setSelectedFileIds(new Set())}
                      className="text-[9px] font-black text-red-500 uppercase tracking-widest hover:underline"
                    >
                      Bỏ chọn
                    </button>
                  )}
                </div>
              )}

              {files.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-8 opacity-40">
                  <FileSearch className="w-16 h-16 mb-4 text-slate-300" />
                  <p className="text-sm font-bold text-slate-400 uppercase tracking-widest">Chưa có dữ liệu</p>
                </div>
              ) : (
                <div className="flex-1 space-y-2 overflow-y-auto pr-2 custom-scrollbar">
                  {files.map((item) => (
                    <div 
                      key={item.id}
                      onClick={() => setSelectedResultId(item.id)}
                      className={`
                        group p-3 rounded-xl border transition-all flex items-center gap-3 cursor-pointer
                        ${selectedResultId === item.id ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-slate-100 hover:border-slate-300 bg-white'}
                      `}
                    >
                      <div 
                        onClick={(e) => toggleSelectFile(item.id, e)}
                        className={`
                          w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-all
                          ${selectedFileIds.has(item.id) ? 'bg-blue-600 border-blue-600' : 'bg-white border-slate-300'}
                        `}
                      >
                        {selectedFileIds.has(item.id) && <CheckCircle2 className="w-3 h-3 text-white" />}
                      </div>

                      <div className={`
                        p-2 rounded-lg shrink-0
                        ${item.status === 'completed' ? 'bg-green-100 text-green-600' : 
                          item.status === 'error' ? 'bg-red-100 text-red-600' : 
                          item.status === 'processing' || item.status === 'streaming' ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'}
                      `}>
                        {item.status === 'processing' || item.status === 'streaming' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                      </div>
                      
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-slate-800 truncate">{item.file.name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <p className="text-[9px] text-slate-400 uppercase font-black tracking-tighter">
                            {item.status === 'completed' ? 'Đã đổi tên' : 
                             item.status === 'streaming' ? 'Đang đọc...' :
                             item.status === 'processing' ? 'Đang đọc...' : 
                             item.status === 'error' ? `Lỗi: ${item.error || 'Không xác định'}` : 'Chờ xử lý'}
                          </p>
                          {item.status === 'completed' && (
                            <button 
                              onClick={(e) => { e.stopPropagation(); downloadPdf(item); }}
                              className="text-[9px] text-blue-600 font-black hover:underline flex items-center gap-0.5"
                            >
                              <Download className="w-2 h-2" /> Tải PDF
                            </button>
                          )}
                        </div>
                      </div>

                      {item.status === 'error' && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); processSingleFile(item); }}
                          className="p-1.5 hover:bg-blue-100 hover:text-blue-600 rounded-lg text-blue-400 transition-all"
                          title="Thử lại"
                        >
                          <RefreshCcw className="w-4 h-4" />
                        </button>
                      )}

                      <button 
                        onClick={(e) => { e.stopPropagation(); removeFile(item.id); }}
                        className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-100 hover:text-red-600 rounded-lg text-slate-400 transition-all"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {files.length > 0 && (
                <button
                  disabled={isProcessingAll || (selectedFileIds.size === 0 && files.every(f => f.status === 'completed'))}
                  onClick={selectedFileIds.size > 0 ? processSelected : processAll}
                  className={`
                    w-full mt-6 py-3.5 rounded-xl font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 shadow-lg
                    ${isProcessingAll || (selectedFileIds.size === 0 && files.every(f => f.status === 'completed'))
                      ? 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-none' 
                      : 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-200'}
                  `}
                >
                  {isProcessingAll ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Đang xử lý...
                    </>
                  ) : (
                    <>
                      <FileSearch className="w-5 h-5" />
                      {selectedFileIds.size > 0 
                        ? `Đọc ${selectedFileIds.size} file đã chọn`
                        : files.some(f => f.status === 'error') 
                          ? `Thử lại các file lỗi (${files.filter(f => f.status === 'error').length})`
                          : `Đọc chi tiết (${files.filter(f => f.status === 'idle').length})`}
                    </>
                  )}
                </button>
              )}
            </section>
          </div>

          {/* Slot 3: Chi tiết văn bản */}
          <div className="space-y-6">
            <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 h-full min-h-[600px]">
              <div className="flex items-center gap-2 mb-6">
                <div className="bg-emerald-100 p-2 rounded-lg">
                  <ChevronRight className="w-5 h-5 text-emerald-600" />
                </div>
                <h2 className="text-lg font-black uppercase tracking-tight">3. Chi tiết trích xuất</h2>
              </div>

              <AnimatePresence mode="wait">
                {!selectedFileItem ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-8 opacity-40">
                    <Info className="w-16 h-16 mb-4 text-slate-300" />
                    <p className="text-sm font-bold text-slate-400 uppercase tracking-widest leading-relaxed">
                      Chọn văn bản ở Ô 2<br/>để xem chi tiết
                    </p>
                  </div>
                ) : (
                  <motion.div 
                    key={selectedFileItem.id}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="space-y-6"
                  >
                    <div className="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                      <div className="flex items-center justify-between mb-4">
                        <span className={`
                          text-[9px] font-black px-2 py-1 rounded-full uppercase tracking-widest
                          ${selectedFileItem.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700 animate-pulse'}
                        `}>
                          {selectedFileItem.status === 'completed' ? 'Thành công' : 'Đang xử lý'}
                        </span>
                        <div className="flex items-center gap-2">
                          {selectedFileItem.status === 'completed' && (
                            <button 
                              onClick={() => downloadJson(selectedFileItem)}
                              className="text-[9px] font-black text-blue-600 flex items-center gap-1 hover:underline"
                            >
                              <Download className="w-3 h-3" /> JSON
                            </button>
                          )}
                        </div>
                      </div>
                      <h3 className="font-bold text-slate-800 text-sm truncate mb-1">{selectedFileItem.file.name}</h3>
                      <div className="flex items-center justify-between mb-4">
                        <p className="text-[10px] text-slate-400 italic">Gốc: {selectedFileItem.originalName}</p>
                        {selectedFileItem.result?.usage && (
                          <div className="flex items-center gap-2 text-[9px] font-bold text-slate-400">
                            <span title="Input Tokens">In: {selectedFileItem.result.usage.promptTokens}</span>
                            <span className="w-1 h-1 bg-slate-300 rounded-full" />
                            <span title="Output Tokens">Out: {selectedFileItem.result.usage.candidatesTokens}</span>
                          </div>
                        )}
                      </div>
                      
                      {previewUrl && (
                        <a 
                          href={previewUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="flex items-center justify-center gap-2 w-full py-2.5 bg-blue-50 text-blue-600 rounded-xl border border-blue-100 text-[10px] font-black uppercase tracking-widest hover:bg-blue-100 transition-all"
                        >
                          <ExternalLink className="w-3.5 h-3.5" /> Mở tệp PDF gốc
                        </a>
                      )}
                    </div>

                    {selectedFileItem.result ? (
                      <div className="space-y-5">
                        <DetailItem icon={<Building2 className="w-4 h-4"/>} label="Đơn vị" value={selectedFileItem.result.issuingOrg} color="emerald" />
                        <DetailItem icon={<Hash className="w-4 h-4"/>} label="Số hiệu" value={selectedFileItem.result.documentNumber} color="blue" isMono />
                        <DetailItem icon={<Calendar className="w-4 h-4"/>} label="Ngày" value={selectedFileItem.result.issueDate} color="orange" />
                        <DetailItem icon={<TypeIcon className="w-4 h-4"/>} label="Tiêu đề" value={selectedFileItem.result.title} color="purple" />
                        
                        <div className="pt-2">
                          <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Tóm tắt nội dung</label>
                          <div className="bg-white p-4 rounded-xl border border-slate-100 text-xs text-slate-600 leading-relaxed italic">
                            "{selectedFileItem.result.summary}"
                          </div>
                        </div>

                        <div>
                          <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Nơi nhận</label>
                          <div className="bg-blue-50/50 p-4 rounded-xl border border-blue-100 text-xs text-slate-700 whitespace-pre-line leading-relaxed">
                            {selectedFileItem.result.recipients}
                          </div>
                        </div>
                      </div>
                    ) : selectedFileItem.status === 'error' ? (
                      <div className="p-8 text-center">
                        <AlertCircle className="w-12 h-12 text-red-300 mx-auto mb-4" />
                        <p className="text-xs text-red-500 font-bold">{selectedFileItem.error}</p>
                      </div>
                    ) : (
                      <div className="py-20 text-center">
                        <Loader2 className="w-8 h-8 text-blue-600 animate-spin mx-auto mb-4" />
                        <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">Đang trích xuất dữ liệu...</p>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          </div>

        </div>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
      `}</style>
    </div>
  );
}

function DetailItem({ icon, label, value, color, isMono = false }: { icon: any, label: string, value: string, color: string, isMono?: boolean }) {
  const colors: Record<string, string> = {
    emerald: 'bg-emerald-50 text-emerald-600',
    blue: 'bg-blue-50 text-blue-600',
    orange: 'bg-orange-50 text-orange-600',
    purple: 'bg-purple-50 text-purple-600'
  };

  return (
    <div className="flex gap-3">
      <div className={`p-2 rounded-lg shrink-0 h-fit ${colors[color]}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{label}</label>
        <p className={`text-sm font-bold text-slate-800 mt-0.5 leading-tight ${isMono ? 'font-mono tracking-tighter' : ''}`}>
          {value}
        </p>
      </div>
    </div>
  );
}
