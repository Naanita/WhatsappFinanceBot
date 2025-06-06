require("dotenv").config();
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const fs = require("fs");
const ExcelJS = require('exceljs');
const creds = require("./credentials.json");

const client = new Client({
  puppeteer: { headless: true, args: ["--no-sandbox"] },
  authStrategy: new LocalAuth({ clientId: "bot2" }),
  webVersionCache: {
    type: "remote",
    remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2411.2.html",
  },
  authTimeoutMs: 60000,
  qrTimeout: 30000,
});

const conversationStates = {};
const userData = {};
const timeouts = {};
const adminNumbers = [
  "573223616400@c.us", 
  "573223616400@c.us", 
];
let adminTurn = 0;


client.on("qr", (qr) => qrcode.generate(qr, { small: true }));
client.on("ready", () => console.log("Client is ready!"));
client.on("authenticated", () => console.log("Client is authenticated!"));
client.on("auth_failure", (msg) => console.error("Authentication failure", msg));

function clearTimeouts(from) {
  if (timeouts[from]) {
    clearTimeout(timeouts[from].recordatorio);
    clearTimeout(timeouts[from].finalizacion);
    delete timeouts[from];
  }
}

// Función para crear el cliente JWT de autenticación
function getServiceAccountAuth() {
  return new JWT({
    email: creds.client_email,
    key: creds.private_key.replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ],
  });
}

// Función para buscar NIT y código en Google Sheets con autenticación JWT
async function buscarEnGoogleSheets(nit, codigo = null) {
  try {
    const serviceAccountAuth = getServiceAccountAuth();
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    // 1. Buscar si existe el NIT
    const filasNit = rows.filter(row => {
      const rowNit = row._rawData[0] ? row._rawData[0].toString().trim() : '';
      return rowNit === nit.toString().trim();
    });

    if (filasNit.length === 0) {
      console.log("NIT no encontrado:", nit);
      return null;
    }

    // 2. Si no se pide código, devolver el nombre de la primera coincidencia
    if (!codigo) {
      const rowNombre = filasNit[0]._rawData[2] ? filasNit[0]._rawData[2].toString().trim() : '';
      return { nombre: rowNombre };
    }

    // 3. Buscar si el código existe entre los que coinciden con el NIT
    const filaCodigo = filasNit.find(row => {
      const rowCodigo = row._rawData[1] ? row._rawData[1].toString().trim() : '';
      return rowCodigo === codigo.toString().trim();
    });

    if (!filaCodigo) {
      console.log("Código no encontrado para ese NIT:", codigo);
      return null;
    }

    // 4. Si existe, devolver el nombre
    const rowNombre = filaCodigo._rawData[2] ? filaCodigo._rawData[2].toString().trim() : '';
    return { nombre: rowNombre };
  } catch (error) {
    console.error("Error buscando en Google Sheets:", error);
    throw new Error("No se pudo conectar con la hoja de cálculo.");
  }
}

// Nueva función para crear y enviar el Excel personalizado con autenticación JWT
async function enviarEstadoCuentaPersonalizado(from, nit, codigo) {
  try {
    const serviceAccountAuth = getServiceAccountAuth();
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    // Filtrar todas las filas que coincidan con NIT y código
    const datosFiltrados = rows.filter(row =>
      (row._rawData[0] ? row._rawData[0].toString().trim() : '') === nit.toString().trim() &&
      (row._rawData[1] ? row._rawData[1].toString().trim() : '') === codigo.toString().trim()
    );

    if (datosFiltrados.length === 0) {
      await client.sendMessage(from, "No se encontraron datos para tu NIT y código.");
      return;
    }

    // Obtener el nombre del NIT para el archivo
    let nombre = datosFiltrados[0]._rawData[2] || "usuario";
    // Limpiar el nombre para usarlo en el nombre del archivo
    nombre = nombre.replace(/[^a-zA-Z0-9_\-]/g, "_");

    // Crea un nuevo archivo Excel solo con las columnas requeridas
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Estado de Cuenta');

    // Encabezados y formato
    const headers = [
      'Name 1',
      'Invoice number',
      'CO E-Invoice No.',
      'Outstanding balance',
      'Billing Date',
      'Due date',
      'Days overdue'
    ];
    worksheet.addRow(headers);

    // Estilo para el encabezado
    worksheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'd01e26' }
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });

    // Agrega los datos filtrados
    datosFiltrados.forEach(row => {
      worksheet.addRow([
        row._rawData[2] || '', // Name 1
        row._rawData[3] || '', // Invoice number
        row._rawData[4] || '', // CO E-Invoice No.
        row._rawData[9] || '', // Outstanding balance
        row._rawData[10] || '', // Billing Date
        row._rawData[11] || '', // Due date
        row._rawData[12] || ''  // Days overdue
      ]);
    });

    // Ajustar el ancho de las columnas al contenido
    worksheet.columns.forEach((column) => {
      let maxLength = 0;
      column.eachCell({ includeEmpty: true }, (cell) => {
        const cellValue = cell.value ? cell.value.toString() : '';
        maxLength = Math.max(maxLength, cellValue.length);
      });
      column.width = maxLength < 15 ? 15 : maxLength + 2;
    });

    // Guarda el archivo temporalmente
    const filePath = `./estado_cuenta_${nombre}.xlsx`;
    await workbook.xlsx.writeFile(filePath);

    // Lee el archivo y crea el objeto MessageMedia
    const fileBuffer = fs.readFileSync(filePath);
    const media = new MessageMedia(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileBuffer.toString('base64'),
      `estado_cuenta_${nombre}.xlsx`
    );

    // Envía el archivo por WhatsApp
    await client.sendMessage(from, media, { caption: "*Aquí tienes tu estado de cuenta!*" });

    // Borra el archivo temporal
    fs.unlinkSync(filePath);
  } catch (error) {
    console.error("Error enviando estado de cuenta:", error);
    await client.sendMessage(from, "Ocurrió un error generando o enviando tu estado de cuenta. Intenta más tarde.");
  }
}



client.on("message", async (msg) => {
  const from = msg.from;
  const body = msg.body.trim();

  if (
    !conversationStates[from] &&
    !body.toLowerCase().includes("@hikstatement")
  ) {
    return;
  }

  try {
    // Inicia el flujo
    if (!conversationStates[from] || conversationStates[from] === "ended") {
      conversationStates[from] = "HikStatement";
      clearTimeouts(from);
      await client.sendMessage(from, "¡Hola! 👋 Soy *HikStatement*.\nPor favor, digita tu número de *NIT*");
      // Recordatorio y finalización
      timeouts[from] = {
        recordatorio: setTimeout(async () => {
          if (conversationStates[from] === "HikStatement") {
            await client.sendMessage(from, "¿Estás ahí?");
            timeouts[from].finalizacion = setTimeout(async () => {
              if (conversationStates[from] === "HikStatement") {
                await client.sendMessage(from, "Chat finalizado por inactividad. Escribe cualquier mensaje para iniciar de nuevo.");
                conversationStates[from] = "ended";
                clearTimeouts(from);
                process.exit(0); // Reinicia el servidor
              }
            }, 2400000); // 40 min
          }
        }, 2400000)
      };
      return;
    }

    // Esperando NIT
    if (conversationStates[from] === "HikStatement") {
      clearTimeouts(from);
      const nit = body;
      let resultado;
      try {
        resultado = await buscarEnGoogleSheets(nit);
      } catch (error) {
        await client.sendMessage(from, error.message || "Ocurrió un error buscando tu NIT.");
        conversationStates[from] = "ended";
        return;
      }
      if (resultado) {
        userData[from] = { nit, nombre: resultado.nombre };
        conversationStates[from] = "esperando_codigo";
        await client.sendMessage(from, `¡Hola, *${resultado.nombre}!* Por favor, ingresa tu *código de cliente*`);
        // Recordatorio y finalización
        timeouts[from] = {
          recordatorio: setTimeout(async () => {
            if (conversationStates[from] === "esperando_codigo") {
              await client.sendMessage(from, "¿Estás ahí?");
              timeouts[from].finalizacion = setTimeout(async () => {
                if (conversationStates[from] === "esperando_codigo") {
                  await client.sendMessage(from, "Chat finalizado por inactividad. Escribe cualquier mensaje para iniciar de nuevo.");
                  conversationStates[from] = "ended";
                  clearTimeouts(from);
                  process.exit(0);
                }
              }, 2400000);
            }
          }, 2400000)
        };
      } else {
        await client.sendMessage(from, "NIT no encontrado o no autorizado. Intenta de nuevo o escribe cualquier mensaje para reiniciar.");
        conversationStates[from] = "ended";
      }
      return;
    }

    // Esperando código de verificación
    if (conversationStates[from] === "esperando_codigo") {
      clearTimeouts(from);
      const codigo = body;
      const nit = userData[from]?.nit;
      let resultado;
      try {
        resultado = await buscarEnGoogleSheets(nit, codigo);
      } catch (error) {
        await client.sendMessage(from, error.message || "Ocurrió un error validando tu código.");
        conversationStates[from] = "ended";
        return;
      }
      if (resultado) {
        conversationStates[from] = "menu_opciones";
        userData[from].codigo = codigo; // Guardar el código para usarlo después
        await client.sendMessage(from, "*¿Qué quieres hacer?*\n\n*1.* Descargar estado de cuenta.\n*2.* Otra solicitud");
        // Recordatorio y finalización
        timeouts[from] = {
          recordatorio: setTimeout(async () => {
            if (conversationStates[from] === "menu_opciones") {
              await client.sendMessage(from, "¿Estás ahí?");
              timeouts[from].finalizacion = setTimeout(async () => {
                if (conversationStates[from] === "menu_opciones") {
                  await client.sendMessage(from, "Chat finalizado por inactividad. Escribe cualquier mensaje para iniciar de nuevo.");
                  conversationStates[from] = "ended";
                  clearTimeouts(from);
                  process.exit(0);
                }
              }, 2400000);
            }
          }, 2400000)
        };
      } else {
        await client.sendMessage(from, "Código incorrecto. Intenta de nuevo o escribe cualquier mensaje para reiniciar.");
        conversationStates[from] = "ended";
      }
      return;
    }


    // Menú de opciones
    if (conversationStates[from] === "menu_opciones") {
      clearTimeouts(from);
      if (body === "1") {
        // Envía el archivo personalizado solo con los datos del usuario
        await enviarEstadoCuentaPersonalizado(from, userData[from].nit, userData[from].codigo);
        conversationStates[from] = "menu_post_estado";
        await client.sendMessage(from, "*¿Deseas realizar otra solicitud?*\n\n*1.* Sí, otra solicitud\n*2.* Terminar chat");
      } else if (body === "2") {
        conversationStates[from] = "esperando_solicitud";
        await client.sendMessage(from, "Por favor, escribe tu solicitud:");
      } else {
        await client.sendMessage(from, "Opción no válida. Por favor, responde con 1 para descargar el estado de cuenta o 2 para otra solicitud.");
      }
      return;
    }

    // Menú después de entregar estado de cuenta
    if (conversationStates[from] === "menu_post_estado") {
      clearTimeouts(from);
      if (body === "1") {
        conversationStates[from] = "esperando_solicitud";
        await client.sendMessage(from, "Por favor, escribe tu solicitud:");
      } else if (body === "2") {
        conversationStates[from] = "ended";
        await client.sendMessage(from, "¡Gracias por contactarnos! Si necesitas algo más, escribe cualquier mensaje para iniciar de nuevo.");
      } else {
        await client.sendMessage(from, "Opción no válida. Responde con 1 para otra solicitud o 2 para terminar el chat.");
      }
      return;
    }

        // Esperando texto de solicitud
    if (conversationStates[from] === "esperando_solicitud") {
      clearTimeouts(from);
      userData[from].solicitud = body;
      conversationStates[from] = "esperando_nombre_solicitud";
      await client.sendMessage(from, "Por favor, escribe tu *nombre* para la solicitud:");
      return;
    }


    if (conversationStates[from] === "esperando_nombre_solicitud") {
      clearTimeouts(from);
      userData[from].nombre_solicitud = body;
      conversationStates[from] = "ended";

      // Mensaje de agradecimiento y resumen
      const solicitud = userData[from].solicitud;
      const nombre = userData[from].nombre_solicitud;
      const numero = from.replace(/@c\.us$/, "");
      const resumen = `*¡Gracias!*\nPronto nos pondremos en contacto contigo.\n\n*Solicitud enviada:*\n\`\`\`\n${solicitud}\n\`\`\``;
      await client.sendMessage(from, resumen);

      // Mensaje para el admin correspondiente
      const adminNumber = adminNumbers[adminTurn % adminNumbers.length];
      adminTurn++;
      const mensajeAdmin = `*Nueva solicitud recibida*\n\n*Nombre:* ${nombre}\n*Número:* ${numero}\n*Solicitud:*\n\`\`\`\n${solicitud}\n\`\`\``;
      await client.sendMessage(adminNumber, mensajeAdmin);

      await client.sendMessage(from, "Si necesitas algo más, escribe cualquier mensaje para iniciar de nuevo.");
      return;
    }


  } catch (error) {
    console.error("Error general en el flujo:", error);
    await client.sendMessage(from, "Ocurrió un error inesperado. Intenta de nuevo más tarde.");
    conversationStates[from] = "ended";
  }
});

client
  .initialize()
  .then(() => console.log("Client initialized successfully"))
  .catch((err) => console.error("Error initializing client", err)); 


  const readline = require('readline');
const sessionPath = './.wwebjs_auth/session-bot2';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// ...existing code...
rl.on('line', (input) => {
  if (input.trim().toLowerCase() === 'resetqr') {
    console.log('Buscando sesión en:', sessionPath);
    if (fs.existsSync(sessionPath)) {
      console.log('Eliminando sesión y reiniciando para mostrar QR...');
      fs.rmSync(sessionPath, { recursive: true, force: true });
    } else {
      console.log('No se encontró la carpeta de sesión, se mostrará el QR al reiniciar.');
    }
    process.exit(0);
  }
});
// ...existing code...