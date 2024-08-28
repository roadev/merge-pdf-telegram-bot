require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const token = process.env.BOT_API_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const handleMessage = async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text && !text.startsWith('/')) {
    const links = parseLinks(text);

    if (links.length === 0) {
      await sendMessage(chatId, 'Please provide valid PDF links separated by commas or new lines.');
      return;
    }

    await sendMessage(chatId, 'Downloading PDFs...');
    await handlePDFLinks(links, chatId);
  }
};

const parseLinks = (text) =>
  text.split(/[\n,]+/).map(link => link.trim()).filter(link => link);

const convertGoogleDriveLink = (link) => {
  const match = link.match(/\/file\/d\/(.*)\/view/);
  return match ? `https://drive.google.com/uc?export=download&id=${match[1]}` : link;
};

const downloadFile = async (link) => {
  if (link.includes('drive.google.com')) {
    await downloadGoogleDrivePDF(convertGoogleDriveLink(link));
  }
  await downloadDirectPDF(link);
};

const downloadDirectPDF = async (link) => {
  const response = await axios.get(link, { responseType: 'arraybuffer' });
  const contentType = response.headers['content-type'];

  if (!contentType || !contentType.includes('pdf')) {
    throw new Error('The link does not point to a PDF file.');
  }
  return response.data;
};

const downloadGoogleDrivePDF = async (link) => {
  const response = await axios.get(link, { responseType: 'stream' });
  const contentDisposition = response.headers['content-disposition'];
  const isPDF = contentDisposition && contentDisposition.includes('.pdf');

  if (!isPDF) {
    throw new Error('The Google Drive link does not point directly to a PDF file.');
  }

  await streamToBuffer(response.data);
};

const streamToBuffer = (stream) =>
  new Promise((resolve, reject) => {
    const dataArray = [];
    stream.on('data', (chunk) => dataArray.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(dataArray)));
    stream.on('error', (err) => reject(err));
  });

const downloadPDFs = async (links) => {
  const downloadResults = await Promise.all(links.map(async (link) => {
    try {
      const data = await downloadFile(link);
      return { status: 'success', link, data };
    } catch (error) {
      return { status: 'failed', link, error: error.message };
    }
  }));

  return downloadResults;
};

const mergePDFs = async (pdfBuffers) => {
  const mergedPdf = await PDFDocument.create();
  const mergeTasks = pdfBuffers.map(async (pdfBuffer) => {
    const pdf = await PDFDocument.load(pdfBuffer);
    const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  });

  await Promise.all(mergeTasks);
  return mergedPdf.save();
};

const handlePDFLinks = async (links, chatId) => {
  const downloadResults = await downloadPDFs(links);

  const successfulDownloads = downloadResults.filter(result => result.status === 'success');
  const failedDownloads = downloadResults.filter(result => result.status === 'failed');

  if (failedDownloads.length > 0) {
    const failedLinksMessage = `Failed to download ${failedDownloads.length} files:\n\n` +
      failedDownloads.map(result => result.link).join('\n');
    await sendMessage(chatId, failedLinksMessage);
  }

  if (successfulDownloads.length === 0) {
    await sendMessage(chatId, 'No valid PDFs were downloaded.');
    return;
  }

  try {
    const pdfBuffers = successfulDownloads.map(result => result.data);
    const mergedPdfBuffer = await mergePDFs(pdfBuffers);
    await sendPDFDocument(chatId, mergedPdfBuffer, 'merged.pdf');
  } catch (error) {
    console.error('Error merging PDFs:', error);
    await sendMessage(chatId, 'An error occurred while processing the PDFs.');
  }

  await sendSummaryMessage(chatId, successfulDownloads.length, failedDownloads.length);
};

const sendSummaryMessage = async (chatId, successCount, failureCount) => {
  const summaryMessage = `Summary:\n\n` +
    `Successfully Merged PDFs: ${successCount}\n` +
    `Failed to Merge PDFs: ${failureCount}`;
  
  await sendMessage(chatId, summaryMessage);
};

const sendMessage = async (chatId, text) => await bot.sendMessage(chatId, text);

const sendPDFDocument = async (chatId, pdfBuffer, filename) => {
  const filePath = path.join(__dirname, filename);
  fs.writeFileSync(filePath, pdfBuffer);

  try {
    await bot.sendDocument(chatId, filePath, {}, { filename, contentType: 'application/pdf' });
    fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Error sending PDF document:', error);
  }
};

bot.onText(/\/start/, async (msg) => await sendMessage(msg.chat.id, 'Send me a list of PDF links separated by commas or new lines.'));
bot.on('message', handleMessage);

console.log('Bot running...');
