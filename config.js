// Configuración pública de Correo Norma.
// El Client ID de OAuth no es secreto: solo funciona desde el dominio autorizado en Google Cloud.
window.CORREO_CONFIG = {
  clientId: "377594505277-vohmfh5ltlg9fm65dkt3oo2e52nilcni.apps.googleusercontent.com",
  scopes: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/calendar.events"
  ].join(" "),

  // Personas a las que se delega
  equipo: [
    { nombre: "Constance", email: "coordinador@22q13.org.es", saludo: "Hola Constance," },
    { nombre: "Paz", email: "comunicacion@22q13.org.es", saludo: "Hola Paz," },
    { nombre: "Leyre", email: "sio@22q13.org.es", saludo: "Hola Leyre," }
  ],
  remitenteDelegar: "norma.alhambra@22q13.org.es",

  // Nombres de las etiquetas de Gmail
  etiquetas: {
    urgente: "Urgente",
    personal: "Personal",
    sensible: "Sensible",
    ayto: "Trabajo Ayto",
    responder: "Responder yo",
    clave: "Personas clave",
    firmar: "Firmar-decidir",
    delegar: "Delegar",
    leer: "Solo leer",
    pedirBorrador: "Pedir borrador",
    corregido: "Corregido",
    delegado: "Delegado",
    pospuesto: "Pospuesto"
  },

  // Para agrupar por organización
  pmsgoPistas: ["pms go", "pmsgo", "pms-go", "global organization"],
  aytoPistas: ["aytoboadilla.com"],
  diasSeguimiento: 2
};
