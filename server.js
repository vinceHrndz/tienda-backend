require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 4000;

// ─── CORRECCIÓN 1: SUPABASE_URL sin /rest/v1/ al final ──────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Middlewares ──────────────────────────────────────────────────────────────
// CRÍTICO: /webhook debe ir ANTES de express.json() para recibir el body raw
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── CORRECCIÓN 2: CORS restrictivo con allowedHeaders para Authorization ────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:4173',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('No permitido por CORS'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// ─── Catálogo de consolas ─────────────────────────────────────────────────────
const CONSOLAS = [
  {
    id: 'ps5-slim',
    nombre: 'PlayStation 5 Slim 1TB',
    descripcion: 'Edición Estándar con lector de discos. Incluye control DualSense Wireless con retroalimentación háptica.',
    precio: 10500,
    imagen: 'https://images.unsplash.com/photo-1606813907291-d86efa9b94db?w=600&q=80',
    categoria: 'Sony',
    stock: 15,
    badge: 'MÁS VENDIDO'
  },
  {
    id: 'xbox-series-x',
    nombre: 'Xbox Series X 1TB',
    descripcion: 'La consola Xbox más potente. 4K gaming, 120fps, Quick Resume y Game Pass compatible.',
    precio: 9800,
    imagen: 'https://images.unsplash.com/photo-1621259182978-fbf93132d53d?w=600&q=80',
    categoria: 'Microsoft',
    stock: 10,
    badge: null
  },
  {
    id: 'nintendo-switch-oled',
    nombre: 'Nintendo Switch OLED',
    descripcion: 'Pantalla OLED de 7" vibrante. Dock con puerto LAN. Almacenamiento interno de 64GB.',
    precio: 6999,
    imagen: 'https://images.unsplash.com/photo-1578303512597-81e6cc155b3e?w=600&q=80',
    categoria: 'Nintendo',
    stock: 25,
    badge: 'OFERTA'
  },
  {
    id: 'steam-deck-512',
    nombre: 'Steam Deck OLED 512GB',
    descripcion: 'PC gaming portátil con pantalla OLED HDR de 7.4". Toda tu biblioteca de Steam en tus manos.',
    precio: 12500,
    imagen: 'https://images.unsplash.com/photo-1697729438019-ee8fd956e2dc?w=600&q=80',
    categoria: 'Valve',
    stock: 8,
    badge: 'NUEVO'
  }
];

// ─── Helper: verificar token de Supabase ─────────────────────────────────────
async function getUserFromToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// ─── Rutas ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /api/productos
app.get('/api/productos', (req, res) => {
  res.json({ success: true, data: CONSOLAS });
});

// GET /api/productos/:id
app.get('/api/productos/:id', (req, res) => {
  const consola = CONSOLAS.find(c => c.id === req.params.id);
  if (!consola) return res.status(404).json({ success: false, error: 'Producto no encontrado' });
  res.json({ success: true, data: consola });
});

// ─── NUEVO: POST /api/create-checkout-session — ahora acepta CARRITO ─────────
// Body: { items: [{ productoId, cantidad }] }  ó  { productoId, cantidad } (legacy)
app.post('/api/create-checkout-session', async (req, res) => {
  // Soporte para carrito (array) y compra directa (objeto)
  let items = [];
  if (req.body.items && Array.isArray(req.body.items)) {
    items = req.body.items;
  } else if (req.body.productoId) {
    items = [{ productoId: req.body.productoId, cantidad: req.body.cantidad || 1 }];
  } else {
    return res.status(400).json({ success: false, error: 'Se requieren items en el carrito' });
  }

  // Validar stock para todos los items
  const lineItems = [];
  const metadataItems = [];
  for (const item of items) {
    const consola = CONSOLAS.find(c => c.id === item.productoId);
    if (!consola) return res.status(404).json({ success: false, error: `Producto no encontrado: ${item.productoId}` });
    if (consola.stock < item.cantidad) return res.status(400).json({ success: false, error: `Stock insuficiente para ${consola.nombre}` });

    lineItems.push({
      price_data: {
        currency: 'mxn',
        product_data: {
          name: consola.nombre,
          description: consola.descripcion,
          images: [consola.imagen],
        },
        unit_amount: consola.precio * 100,
      },
      quantity: item.cantidad,
    });
    metadataItems.push({ id: item.productoId, qty: item.cantidad });
  }

  // Obtener usuario autenticado (opcional)
  const user = await getUserFromToken(req);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/exito?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancelado`,
      metadata: {
        items: JSON.stringify(metadataItems),
        user_id: user?.id || '',
      },
      customer_email: user?.email || null,
      billing_address_collection: 'auto',
    });

    res.json({ success: true, url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Error Stripe:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/verificar-pago/:sessionId
app.get('/api/verificar-pago/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items', 'customer_details']
    });

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ success: false, error: 'El pago no fue completado' });
    }

    const { data: ordenExistente } = await supabase
      .from('ordenes')
      .select('id')
      .eq('stripe_session_id', sessionId)
      .single();

    let ordenId = ordenExistente?.id;

    if (!ordenExistente) {
      const parsedItems = JSON.parse(session.metadata.items || '[]');
      // Calcular total real desde line_items
      const totalMxn = session.amount_total / 100;

      const { data: nuevaOrden, error: dbError } = await supabase
        .from('ordenes')
        .insert({
          stripe_session_id: sessionId,
          stripe_payment_intent: session.payment_intent,
          items: parsedItems,
          total_mxn: totalMxn,
          nombre_cliente: session.customer_details?.name || 'Cliente',
          email_cliente: session.customer_details?.email || '',
          estado: 'completado',
          user_id: session.metadata.user_id || null,
        })
        .select('id')
        .single();

      if (dbError) console.error('Error Supabase al guardar orden:', dbError.message);
      else ordenId = nuevaOrden?.id;
    }

    // Construir resumen de items para la respuesta
    const parsedItems = JSON.parse(session.metadata.items || '[]');
    const productosResumen = parsedItems.map(item => {
      const c = CONSOLAS.find(c => c.id === item.id);
      return { nombre: c?.nombre || item.id, cantidad: item.qty };
    });

    res.json({
      success: true,
      data: {
        ordenId,
        nombreCliente: session.customer_details?.name || 'Cliente',
        emailCliente: session.customer_details?.email || '',
        productos: productosResumen,
        totalPagado: session.amount_total / 100,
        moneda: session.currency.toUpperCase(),
        paymentIntent: session.payment_intent,
        estado: 'Completado ✓'
      }
    });
  } catch (err) {
    console.error('Error verificar pago:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/mis-ordenes — historial del usuario autenticado
app.get('/api/mis-ordenes', async (req, res) => {
  const user = await getUserFromToken(req);
  if (!user) return res.status(401).json({ success: false, error: 'No autenticado' });

  const { data, error } = await supabase
    .from('ordenes')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data });
});

// POST /webhook — Stripe webhooks
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('✅ Pago completado via webhook:', session.id);
    // Aquí puedes enviar email, actualizar inventario, etc.
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_test') ? 'TEST MODE' : 'PRODUCCIÓN'}`);
});
