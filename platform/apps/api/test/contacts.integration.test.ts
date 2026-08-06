import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { systemPrisma } from "@platform/db";

import { buildServer, generateApiKey } from "../dist/index.js";

/**
 * `/v1/contacts`, de punta a punta.
 *
 * Lo que de verdad se prueba aquí es el aislamiento. Un contacto es el dato
 * personal por excelencia —nombre, correo, teléfono— y `crm-main`, el
 * repositorio de referencia, es irreparable justo por esto: su `Contact.email`
 * es `@unique` GLOBAL, así que dos clientes no pueden tener a la misma persona
 * en su agenda. Los tests de unicidad de abajo son los que dicen que aquí no
 * pasa eso.
 */

const TENANT = "tnt_contact_acme";
const RIVAL = "tnt_contact_rival";

let clave = "";
let claveRival = "";

const auth = (secret: string): Record<string, string> => ({
  authorization: `Bearer ${secret}`,
});

describe(
  "contactos",
  { skip: process.env["DATABASE_URL"] === undefined },
  () => {
    const app = buildServer();

    before(async () => {
      for (const [id, slug] of [
        [TENANT, "contact-acme"],
        [RIVAL, "contact-rival"],
      ] as const) {
        await systemPrisma.tenant.upsert({
          where: { id },
          update: {},
          create: { id, slug, name: slug },
        });
      }

      for (const [tenantId, target] of [
        [TENANT, "propia"],
        [RIVAL, "rival"],
      ] as const) {
        const issued = generateApiKey();
        await systemPrisma.apiKey.create({
          data: {
            tenantId,
            name: `clave ${target}`,
            keyHash: issued.keyHash,
            last4: issued.last4,
            scopes: ["contacts:read", "contacts:write"],
          },
        });
        if (target === "propia") clave = issued.secret;
        else claveRival = issued.secret;
      }

      await app.ready();
    });

    after(async () => {
      await app.close();
      await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT, RIVAL] } } });
      await systemPrisma.$disconnect();
    });

    test("se crea un contacto y se recupera por su id", async () => {
      const creado = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: auth(clave),
        payload: {
          displayName: "Marta Ruiz",
          email: "marta@ejemplo.es",
          attributes: { plan: "starter" },
        },
      });

      assert.equal(creado.statusCode, 201);
      const cuerpo = creado.json();
      assert.equal(cuerpo.email, "marta@ejemplo.es");
      assert.deepEqual(cuerpo.attributes, { plan: "starter" });

      const leido = await app.inject({
        method: "GET",
        url: `/v1/contacts/${cuerpo.id}`,
        headers: auth(clave),
      });

      assert.equal(leido.statusCode, 200);
      assert.equal(leido.json().displayName, "Marta Ruiz");
      // El historial viene con el contacto: saber que ya preguntó tres veces
      // cambia cómo se la atiende.
      assert.deepEqual(leido.json().conversations, []);
    });

    test("un contacto sin ningún identificador se rechaza", async () => {
      // Sin email, teléfono ni externalId no se le puede volver a encontrar, así
      // que la siguiente conversación crearía un duplicado en silencio.
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: auth(clave),
        payload: { displayName: "Anónimo" },
      });

      assert.equal(respuesta.statusCode, 400);
      assert.equal(respuesta.json().error.code, "invalid_contact");
    });

    test("externalId sin canal se rechaza", async () => {
      // El mismo literal en WhatsApp y en Slack son dos personas distintas.
      const respuesta = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: auth(clave),
        payload: { externalId: "U123" },
      });

      assert.equal(respuesta.statusCode, 400);
    });

    test("repetir un correo dentro del mismo tenant da 409, no 500", async () => {
      await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: auth(clave),
        payload: { email: "duplicada@ejemplo.es" },
      });

      const segunda = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: auth(clave),
        payload: { email: "duplicada@ejemplo.es" },
      });

      // 409 porque la unicidad hizo su trabajo y el cliente tiene que decidir.
      // Un 500 le haría creer que el fallo es nuestro.
      assert.equal(segunda.statusCode, 409);
      assert.equal(segunda.json().error.code, "contact_exists");
    });

    test("el MISMO correo en dos tenants distintos convive sin chocar", async () => {
      // Este es el test que separa este esquema del de `crm-main`. Con un
      // `@unique` global sobre email, el segundo POST daría 409 y el producto
      // sería invendible: dos clientes no podrían tener a la misma persona.
      const propia = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: auth(clave),
        payload: { email: "compartida@ejemplo.es", displayName: "Vista por Acme" },
      });

      const rival = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: auth(claveRival),
        payload: { email: "compartida@ejemplo.es", displayName: "Vista por Rival" },
      });

      assert.equal(propia.statusCode, 201);
      assert.equal(rival.statusCode, 201, "la unicidad no puede ser global");
      assert.notEqual(propia.json().id, rival.json().id);
    });

    test("el contacto de un cliente no se ve desde otro", async () => {
      const creado = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: auth(clave),
        payload: { email: "privada@ejemplo.es" },
      });
      const id = creado.json().id as string;

      // Por su id exacto: 404 y no 403, porque para el rival ese contacto no
      // existe. Un 403 confirmaría que existe, que es media fuga.
      const porId = await app.inject({
        method: "GET",
        url: `/v1/contacts/${id}`,
        headers: auth(claveRival),
      });
      assert.equal(porId.statusCode, 404);

      // Y por búsqueda: el correo del vecino no aparece en su lista.
      const buscando = await app.inject({
        method: "GET",
        url: "/v1/contacts?email=privada@ejemplo.es",
        headers: auth(claveRival),
      });
      assert.equal(buscando.statusCode, 200);
      assert.deepEqual(buscando.json().contacts, []);
    });

    test("se actualiza un contacto y el cambio persiste", async () => {
      const creado = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: auth(clave),
        payload: { phone: "+34600111000", displayName: "Sin apellido" },
      });
      const id = creado.json().id as string;

      const actualizado = await app.inject({
        method: "PATCH",
        url: `/v1/contacts/${id}`,
        headers: auth(clave),
        payload: { displayName: "Con apellido" },
      });

      assert.equal(actualizado.statusCode, 200);
      assert.equal(actualizado.json().displayName, "Con apellido");
      // Lo que no se manda no se toca.
      assert.equal(actualizado.json().phone, "+34600111000");
    });

    test("actualizar el contacto de otro cliente da 404", async () => {
      const creado = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: auth(clave),
        payload: { email: "intocable@ejemplo.es" },
      });

      const respuesta = await app.inject({
        method: "PATCH",
        url: `/v1/contacts/${creado.json().id}`,
        headers: auth(claveRival),
        payload: { displayName: "Secuestrado" },
      });

      assert.equal(respuesta.statusCode, 404);
    });

    test("los contactos exigen su propio ámbito", async () => {
      const issued = generateApiKey();
      await systemPrisma.apiKey.create({
        data: {
          tenantId: TENANT,
          name: "sin contactos",
          keyHash: issued.keyHash,
          last4: issued.last4,
          scopes: ["knowledge:read"],
        },
      });

      const respuesta = await app.inject({
        method: "GET",
        url: "/v1/contacts",
        headers: auth(issued.secret),
      });

      assert.equal(respuesta.statusCode, 403);
    });

    test("la lista sale por visto por última vez, no por antigüedad", async () => {
      // Quien escribió hoy importa más que quien se dio de alta primero.
      const antiguo = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: auth(clave),
        payload: { email: "antiguo@ejemplo.es" },
      });

      await systemPrisma.contact.update({
        where: { id: antiguo.json().id as string },
        data: { lastSeenAt: new Date("2020-01-01T00:00:00Z") },
      });

      const lista = await app.inject({
        method: "GET",
        url: "/v1/contacts?limit=200",
        headers: auth(clave),
      });

      const correos = (lista.json().contacts as { email: string | null }[]).map(
        (c) => c.email,
      );
      assert.equal(
        correos[correos.length - 1],
        "antiguo@ejemplo.es",
        "el visto hace más tiempo tiene que quedar el último",
      );
    });
  },
);
