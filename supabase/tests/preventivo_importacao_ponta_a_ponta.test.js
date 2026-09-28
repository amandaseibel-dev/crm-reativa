// IMPORTAÇÃO DO PREVENTIVO, PONTA A PONTA:
// CSV cru → reconhecimento do cabeçalho → mapeamento → `linhaParaRegistro` →
// payload → RPC real em PostgreSQL real (PGlite) → títulos gravados.
//
// POR QUE ESTE ARQUIVO EXISTE. Em 28/09/2026, `Vcto Origem` e `Saldo
// Atualizado` eram reconhecidos no mapeamento e **descartados** por
// `linhaParaRegistro`. Nada quebrava: a importação rodava, o número fechava, e
// 5 títulos sumiam calados (R$ 16.680,23 no arquivo real), porque sem
// `vencimento_origem` a chave do título vira "<Dt Vcto>|" para todo mundo e
// dois títulos do mesmo aluno com o mesmo vencimento atual colidem.
//
// Os testes que existiam não pegaram porque montavam a linha À MÃO, já com
// `vencimento_origem`, pulando justamente o trecho defeituoso. Aqui o caminho
// é percorrido inteiro, a partir do texto do CSV.
//
// O CABEÇALHO é o REAL do relatório de inadimplência da ULBRA. As LINHAS são
// inventadas: nome, telefone, e-mail e valores não pertencem a ninguém. A
// matrícula `2026003068` e as datas do caso aparecem porque é o cenário que a
// gestão mandou cobrir — quatro mensalidades com o MESMO `Dt Vcto` (18/09) e
// quatro `Vcto Origem` diferentes, que precisam continuar sendo quatro
// títulos.
import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lerCsv, decodificar, sugerirMapeamento, camposObrigatoriosFaltando,
  linhaParaRegistro, CAMPOS, CAMPO_NO_PAYLOAD,
} from "../../src/utils/preventivo.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const GESTAO = "amanda.seibel@aelbra.com.br";

// Cabeçalho REAL, linhas inventadas.
const CABECALHO =
  '"Código";"Nome do Aluno";"Curso";"Dt Vcto ";"Vcto Origem ";"Responsável";' +
  '"E-mail";"Telefone";"Endereço";"Saldo Original";"Saldo Atualizado";' +
  '"Estabelecimento";"Processo";"Escola";"Situação Acadêmica";"Tipo de Boleto"';

const linha = ({ cod, nome, dtVcto, origem, saldo, saldoAtu, email, tel }) =>
  `"${cod}";"${nome}";"MEDICINA";"${dtVcto}";"${origem}";"";"${email}";"${tel}";` +
  `"Rua Inventada 1 Bairro: Centro Cidade: Canoas CEP: 92000-000 RS";` +
  `"${saldo}";"${saldoAtu}";"UNIDADE TESTE";"14762";"HUMAN";"Matriculado Curso Normal";"Mensalidade";`;

// O caso obrigatório: mesmo Dt Vcto, quatro Vcto Origem.
const QUATRO_ORIGENS = ["05/06/2026", "05/07/2026", "05/08/2026", "05/09/2026"];

const CSV = [
  CABECALHO,
  ...QUATRO_ORIGENS.map((origem, i) => linha({
    cod: "2026003068", nome: "Aluna de Teste", dtVcto: "18/09/2026", origem,
    saldo: `1.00${i},10`, saldoAtu: `1.10${i},20`,
    email: "aluna@exemplo.com", tel: "(51) 99999-0001",
  })),
  // um aluno comum, um título só
  linha({
    cod: "2026000001", nome: "Outro Aluno", dtVcto: "05/09/2026", origem: "05/09/2026",
    saldo: "500,00", saldoAtu: "517,35", email: "outro@exemplo.com", tel: "(51) 98888-0002",
  }),
].join("\r\n") + "\r\n";

async function novoBanco() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table public._jwt (email text);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select jsonb_build_object('email', (select email from public._jwt limit 1)) $$;
    create table public.usuarios (email text, ativo boolean default true);
    insert into public.usuarios values ('${GESTAO}', true);
    insert into public._jwt values ('${GESTAO}');
  `);
  for (const f of [
    "supabase/migrations/20260928143743_preventivo_estrutura.sql",
    "supabase/migrations/20260928143843_preventivo_importacao.sql",
    "supabase/migrations/20260928143943_preventivo_sincronizacao_acoes.sql",
  ]) await db.exec(ler(f));
  return db;
}

const um = async (db, sql, p = []) => {
  const r = await db.query(sql, p);
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
};

// O caminho inteiro, do texto do arquivo ao payload — é o que a tela faz.
function doCsvAoPayload(texto) {
  const linhas = lerCsv(decodificar(new TextEncoder().encode(texto)));
  const cab = linhas[0];
  const corpo = linhas.slice(1).filter((l) => l[0]);
  const mapa = sugerirMapeamento(cab);
  return { cab, mapa, registros: corpo.map((l) => linhaParaRegistro(l, mapa)) };
}

describe("do CSV ao payload: nenhum campo mapeado se perde no caminho", () => {
  it("todo campo de CAMPOS tem destino no payload", () => {
    // A trava estrutural: acrescentar um campo em CAMPOS e esquecer de
    // transportá-lo reprova aqui, não em produção.
    for (const c of CAMPOS) {
      expect([c.id, CAMPO_NO_PAYLOAD[c.id]]).toEqual([c.id, c.id]);
    }
  });

  it("todo campo reconhecido no cabeçalho REAL chega preenchido ao payload", () => {
    const { cab, mapa, registros } = doCsvAoPayload(CSV);
    expect(camposObrigatoriosFaltando(mapa)).toEqual([]);
    const r = registros[0];
    for (const id of Object.keys(mapa)) {
      expect([id, cab[mapa[id]], r[id] === undefined ? "AUSENTE_NO_PAYLOAD" : "ok"])
        .toEqual([id, cab[mapa[id]], "ok"]);
    }
  });

  it("Vcto Origem e Saldo Atualizado chegam com o valor certo", () => {
    const { registros } = doCsvAoPayload(CSV);
    expect(registros[0].vencimento).toBe("2026-09-18");
    expect(registros[0].vencimento_origem).toBe("2026-06-05");
    expect(registros[0].saldo).toBe("1000.1");
    expect(registros[0].saldo_atualizado).toBe("1100.2");
    expect(registros[3].vencimento_origem).toBe("2026-09-05");
  });
});

describe("matrícula 2026003068: mesmo Dt Vcto, quatro Vcto Origem", () => {
  let db, carteira;

  beforeEach(async () => {
    db = await novoBanco();
    carteira = await um(db,
      `select public.preventivo_carteira_criar('Cenário 2026003068', null, '2026-01-01'::date, '2027-12-31'::date)`);
  });

  const importar = async (texto, nome = "Lote 1") => {
    const { mapa, registros } = doCsvAoPayload(texto);
    return um(db, `select public.preventivo_lote_confirmar($1::uuid, $2, 'relatorio.csv', $3::jsonb, null, $4::jsonb)`,
      [carteira, nome, JSON.stringify(mapa), JSON.stringify(registros)]);
  };

  it("permanecem QUATRO títulos distintos, um por vencimento de origem", async () => {
    const resumo = await importar(CSV);
    expect(resumo.linhas_lidas).toBe(5);
    expect(resumo.linhas_recusadas).toBe(0);

    const doAluno = (await db.query(
      `select vencimento::text, vencimento_origem::text, chave_arquivo, saldo_informado, saldo_informado_atualizado
         from public.prev_titulo where matricula_prime = '2026003068' order by vencimento_origem`)).rows;

    expect(doAluno).toHaveLength(4);
    expect(doAluno.map((t) => t.vencimento_origem))
      .toEqual(["2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"]);
    // todos com o MESMO vencimento atual — é isso que colidia antes
    expect(new Set(doAluno.map((t) => t.vencimento))).toEqual(new Set(["2026-09-18"]));
    // e quatro chaves diferentes
    expect(new Set(doAluno.map((t) => t.chave_arquivo)).size).toBe(4);
    // o saldo atualizado do arquivo também chegou
    expect(doAluno.every((t) => t.saldo_informado_atualizado !== null)).toBe(true);
  });

  it("a mutação prova o defeito: sem vencimento_origem, três títulos somem", async () => {
    // Reproduz exatamente o que acontecia antes da correção.
    const { mapa, registros } = doCsvAoPayload(CSV);
    const comoEraAntes = registros.map(({ vencimento_origem, saldo_atualizado, ...resto }) => resto);
    const resumo = await um(db,
      `select public.preventivo_lote_confirmar($1::uuid, 'Como era antes', 'x', $2::jsonb, null, $3::jsonb)`,
      [carteira, JSON.stringify(mapa), JSON.stringify(comoEraAntes)]);

    expect(resumo.recusas_por_motivo.DUPLICADA_NO_ARQUIVO).toBe(3);
    expect(await um(db, `select count(*)::int from public.prev_titulo where matricula_prime = '2026003068'`)).toBe(1);
  });

  it("reimportar o mesmo arquivo continua não duplicando", async () => {
    await importar(CSV, "Lote 1");
    await importar(CSV, "Lote 2");
    expect(await um(db, `select count(*)::int from public.prev_titulo`)).toBe(5);
    expect(Number(await um(db, `select sum(saldo_informado) from public.prev_titulo`)))
      .toBeCloseTo(1000.1 + 1001.1 + 1002.1 + 1003.1 + 500, 2);
  });

  it("a janela conta pelo Dt Vcto, e o Vcto Origem não interfere", async () => {
    await importar(CSV);
    const t = await um(db, `select public.preventivo_titulos($1::uuid)`, [carteira]);
    const quatro = t.filter((x) => x.matricula === "2026003068");
    expect(quatro).toHaveLength(4);
    // o atraso de todos é o mesmo, porque o vencimento atual é o mesmo —
    // embora as origens estejam a até 3 meses de distância
    expect(new Set(quatro.map((x) => x.dias_atraso)).size).toBe(1);
  });
});
