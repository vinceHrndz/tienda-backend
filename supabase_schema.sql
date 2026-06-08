-- ============================================================
-- SCHEMA ACTUALIZADO — Tienda de Consolas
-- Ejecutar en el SQL Editor de tu proyecto Supabase
-- ============================================================

-- NOTA: La tabla de usuarios (auth.users) la maneja Supabase Auth automáticamente.
-- No necesitas crear una tabla de usuarios manualmente.

-- Tabla de órdenes (actualizada para soportar carrito multi-producto)
CREATE TABLE IF NOT EXISTS ordenes (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  stripe_session_id     TEXT UNIQUE NOT NULL,
  stripe_payment_intent TEXT,
  -- CAMBIO: items como JSONB para soportar múltiples productos (carrito)
  -- Formato: [{"id": "ps5-slim", "qty": 2}, {"id": "xbox-series-x", "qty": 1}]
  items                 JSONB NOT NULL DEFAULT '[]',
  total_mxn             DECIMAL(10,2) NOT NULL,
  nombre_cliente        TEXT,
  email_cliente         TEXT,
  -- FK a auth.users (nullable: compras como invitado también se guardan)
  user_id               UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  estado                TEXT DEFAULT 'pendiente'
                          CHECK (estado IN ('pendiente', 'completado', 'cancelado', 'reembolsado')),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_ordenes_user_id  ON ordenes(user_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_email    ON ordenes(email_cliente);
CREATE INDEX IF NOT EXISTS idx_ordenes_estado   ON ordenes(estado);
CREATE INDEX IF NOT EXISTS idx_ordenes_created  ON ordenes(created_at DESC);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_updated_at ON ordenes;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON ordenes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Row Level Security
ALTER TABLE ordenes ENABLE ROW LEVEL SECURITY;

-- El service_role del backend bypasea RLS; el frontend autenticado solo ve sus propias órdenes
CREATE POLICY "Usuario ve sus propias ordenes"
  ON ordenes FOR SELECT
  USING (auth.uid() = user_id);

-- El insert lo hace el backend con service_role (bypasea RLS), pero esta policy
-- permite que en el futuro el frontend pueda insertar si se requiere
CREATE POLICY "Solo service_role inserta ordenes"
  ON ordenes FOR INSERT
  WITH CHECK (false);

-- Vista de estadísticas para admin
CREATE OR REPLACE VIEW estadisticas AS
SELECT
  COUNT(*)                                          AS total_ordenes,
  SUM(total_mxn)                                    AS ingresos_totales,
  AVG(total_mxn)                                    AS ticket_promedio,
  COUNT(CASE WHEN estado = 'completado' THEN 1 END) AS completadas
FROM ordenes
WHERE estado = 'completado';
