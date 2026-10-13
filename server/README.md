# Servidor de pagos — Power Pump Men 2.0

`pagos.ts` corre como **Railway Function** (Bun) en el proyecto `power-pump-pagos`:
<https://pagos-production-3dca.up.railway.app>

## Cómo funciona

1. `checkout.html` manda al servidor solo el kit, la provincia y los datos de envío.
2. El servidor calcula el precio y el envío (las tablas están en `pagos.ts`, el navegador no puede cambiarlas),
   crea la preferencia de **Mercado Pago Checkout Pro** con el Access Token y devuelve el link de pago.
3. El cliente paga en el sitio de Mercado Pago y vuelve a `pago.html`, que consulta el estado real al servidor.
4. Mercado Pago avisa al webhook `/api/webhook`. El servidor vuelve a consultar el pago a Mercado Pago y,
   si está aprobado, manda el email del pedido a `ADMIN_EMAIL` (con confirmación automática al cliente).

## Variables (Railway → power-pump-pagos → pagos → Variables)

| Variable | Qué es |
|---|---|
| `MP_ACCESS_TOKEN` | **Secreto.** Access Token de producción (Mercado Pago → Tus integraciones → tu aplicación → Credenciales de producción). |
| `MP_WEBHOOK_SECRET` | **Secreto, recomendado.** Clave secreta de Webhooks (Tus integraciones → Webhooks). URL: `https://pagos-production-3dca.up.railway.app/api/webhook`, evento "Pagos". |
| `ADMIN_EMAIL` | Email que recibe cada pago aprobado. |
| `SITE_URL` | URL de la tienda, sin barra final. |
| `ALLOWED_ORIGINS` | Sitios que pueden usar el servidor (separados por coma). |
| `STATEMENT_DESCRIPTOR` | Nombre neutro que aparece en el resumen de la tarjeta. |

## Cambiar precios o envíos

Editá `KITS` y `SHIPPING` en `pagos.ts` **y** los mismos valores en `checkout.html` / `index.html`
(la web solo los muestra; el que cobra es el servidor). Después actualizá el código de la función en Railway.
