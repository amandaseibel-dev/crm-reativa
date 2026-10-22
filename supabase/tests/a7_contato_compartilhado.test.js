// A7 — CONTATO COMPARTILHADO E CONTATO INVALIDADO NAO RECEBEM ACAO MASSIVA.
//
// PostgreSQL real (PGlite), sobre a bancada das Acoes Massivas + a migration do
// A7 aplicada por cima. Carteira 100% inventada: nenhum dado real.
//
// O que este arquivo prova, na ordem que a gestao exigiu:
//   * BLOQUEIO ENTRE LOTES: o bloqueio e de ESTADO do cadastro, nao do lote --
//     trocar de lote, de dia, de filtro ou de recencia nao contorna;
//   * CONTATOS INVALIDADOS: `aluno_contatos.valido = false` passa a tirar o
//     canal do envio (antes do A7 nao tinha efeito nenhum);
//   * CANAIS ALTERNATIVOS: telefone compartilhado NAO impede o e-mail proprio;
//   * PERMISSOES DE REVISAO: sinalizar e de qualquer operador; revalidar e
//     liberar sao exclusivos do Administrativo e da supervisao;
//   * AUSENCIA DE REGRESSAO: quem tem contato proprio continua elegivel e
//     exportavel, e os motivos que ja existiam continuam identicos.
//
// Tambem prova os dois casos de borda que decidem o desenho:
//   * ficha duplicada do MESMO CPF nao e colisao (e duplicidade de cadastro);
//   * placeholder nao e colisao -- cai em `contato_indisponivel`, como antes.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  novoBanco as bancadaBase, alunos, universo, previa, exportar,
  comoGestao, comoOperador, OP_A,
} from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIG_A7 = readFileSync(
  resolve(RAIZ, "supabase/migrations/20261022120000_a7_contato_compartilhado_bloqueia_massiva.sql"), "utf8");
const RB_A7 = readFileSync(
  resolve(RAIZ, "supabase/rollbacks/20261022120000_a7_contato_compartilhado_bloqueia_massiva.rollback.sql"), "utf8");

// Pecas que a bancada do universo nao tem porque nao precisava delas.
// `aluno_contatos` espelha as colunas de producao que o A7 usa.
const ALUNO_CONTATOS = `
  create table public.aluno_contatos (
    id uuid primary key default gen_random_uuid(),
    aluno_id uuid, tipo text, valor text, valor_exibicao text, origem text,
    principal boolean, valido boolean default true,
    invalidado_em timestamptz, invalidado_por_email text, motivo_invalidacao text,
    criado_em timestamptz default now(), criado_por_email text);
  create or replace function public.aluno_em_confirmacao_pagamento(p_id text)
  returns text language sql stable as $$ select null::text $$;
`;

// PORTA 2, corpo REAL de producao lido por pg_get_functiondef em 22/10/2026.
// Entra aqui para que os patches 12.a/12.b tenham o que ancorar -- se o corpo
// divergir de producao, `patch_funcao_ancorada` falha e este teste falha.
const PORTA2_PRODUCAO = `
CREATE OR REPLACE FUNCTION public.buscar_candidatos_acoes_massivas(p_ano_vencimento text DEFAULT NULL::text, p_limite integer DEFAULT 6000, p_dias_minimo_sem_contato integer DEFAULT NULL::integer, p_apenas_nunca_acionado boolean DEFAULT false)
 RETURNS TABLE(id uuid, nome text, telefone text, email text, data_ultimo_acionamento timestamp with time zone, valor numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT a.id, a.nome, a.telefone, a.email, a.data_ultimo_acionamento,
         COALESCE(c.total_em_aberto, 0) AS valor
  FROM public.alunos a
  LEFT JOIN public.casos c ON c.aluno_id = a.id AND c.operador_email IS NULL
  WHERE a.responsavel_atual_email IS NULL
    AND (a.data_retorno IS NULL OR a.data_retorno <= current_date)
    AND public.aluno_em_confirmacao_pagamento(a.id::text) IS NULL
    AND coalesce(a.status_jornada,'') NOT IN ('QUITADO','QUITADO_MANUAL')
    AND coalesce(a.status_atual,'')   NOT IN ('QUITADO','QUITADO_MANUAL')
    AND NOT public.caso_encerrado_operacional(a.cpf, a.status_atual, a.status_acionamento, null::text, a.status_jornada)
    AND NOT EXISTS (
      SELECT 1 FROM public.acordos ac WHERE ac.aluno_id = a.id AND ac.status = 'ATIVO'
    )
    AND (
      p_ano_vencimento IS NULL OR EXISTS (
        SELECT 1 FROM public.acordos_titulos at
        WHERE at.aluno_id = a.id
          AND at.situacao = 'ABERTO'
          AND at.vencimento BETWEEN (p_ano_vencimento || '-01-01')::date AND (p_ano_vencimento || '-12-31')::date
      )
    )
    AND (
      p_apenas_nunca_acionado
        AND a.data_ultimo_acionamento IS NULL
      OR NOT p_apenas_nunca_acionado
    )
    AND (
      p_dias_minimo_sem_contato IS NULL
      OR a.data_ultimo_acionamento IS NULL
      OR a.data_ultimo_acionamento <= (now() - (p_dias_minimo_sem_contato || ' days')::interval)
    )
  ORDER BY a.data_ultimo_acionamento ASC NULLS FIRST
  LIMIT p_limite;
END;
$function$;
`;

const ADM = "adm@aelbra.com.br";
const SUP = "fernanda@aelbra.com.br";

async function banco(opts = {}) {
  const db = await bancadaBase(opts);
  await db.exec(ALUNO_CONTATOS);
  await db.exec(PORTA2_PRODUCAO);
  await db.exec(MIG_A7);
  await db.query(
    `insert into public.usuarios (email, nome, perfil, ativo)
     values ($1,'Administrativo','administrativo',true), ($2,'Fernanda','supervisor',true)`,
    [ADM, SUP]);
  await comoGestao(db);
  return db;
}

/** Poe o mesmo contato em varias fichas, direto na ficha (como producao tem). */
async function mesmoContato(db, ids, { telefone = null, email = null } = {}) {
  await db.query(
    `update public.alunos
        set telefone = coalesce($2, telefone), email = coalesce($3, email)
      where id = any($1::uuid[])`,
    [ids, telefone, email]);
}

const porAluno = (rows) => Object.fromEntries(rows.map((r) => [r.aluno_id, r]));
const porta2 = async (db) =>
  (await db.query(`select * from public.buscar_candidatos_acoes_massivas()`)).rows;

// ---------------------------------------------------------------------------
describe("A7 canais alternativos: bloqueia o canal, nao a pessoa", () => {
  it("telefone compartilhado barra o WhatsApp e PRESERVA o e-mail proprio", async () => {
    const db = await banco();
    const [a1, a2, a3] = await alunos(db, 3, {});
    await mesmoContato(db, [a1, a2], { telefone: "(51) 99999-1234" });

    const wpp = porAluno(await universo(db, { canal: "WHATSAPP" }));
    expect(wpp[a1].disponivel).toBe(false);
    expect(wpp[a2].disponivel).toBe(false);
    expect(wpp[a1].motivo).toBe("contato_compartilhado");
    expect(wpp[a2].motivo).toBe("contato_compartilhado");
    expect(wpp[a3].disponivel).toBe(true);

    // o e-mail de cada um e proprio: o canal alternativo continua vivo
    const mail = porAluno(await universo(db, { canal: "EMAIL" }));
    expect(mail[a1].disponivel).toBe(true);
    expect(mail[a2].disponivel).toBe(true);
    expect(mail[a3].disponivel).toBe(true);
  });

  it("quem compartilha os DOIS canais fica sem canal, e so ele", async () => {
    const db = await banco();
    const [a1, a2, a3] = await alunos(db, 3, {});
    await mesmoContato(db, [a1, a2], { telefone: "(51) 99999-1234", email: "casal@x.local" });

    for (const canal of ["WHATSAPP", "EMAIL"]) {
      const u = porAluno(await universo(db, { canal }));
      expect(u[a1].disponivel).toBe(false);
      expect(u[a2].disponivel).toBe(false);
      expect(u[a3].disponivel).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe("A7 bloqueio ENTRE LOTES: e estado do cadastro, nao do lote", () => {
  it("o bloqueio vale em qualquer lote, dia, filtro ou recencia", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await mesmoContato(db, [a1, a2], { telefone: "(51) 99999-1234" });

    // varia tudo o que um operador poderia variar para "tentar de novo"
    const variacoes = [
      { canal: "WHATSAPP" },
      { canal: "WHATSAPP", recencia_dias: 0 },
      { canal: "WHATSAPP", operador: "todos" },
      { canal: "WHATSAPP", valor_min: 0, valor_max: 999999 },
      { canal: "WHATSAPP", aluno_ids: [a1] },
    ];
    for (const f of variacoes) {
      const u = porAluno(await universo(db, f));
      expect(u[a1].disponivel, JSON.stringify(f)).toBe(false);
      expect(u[a1].motivo, JSON.stringify(f)).toBe("contato_compartilhado");
    }

    // e a exportacao de um lote NOVO tambem recusa, com o motivo
    const ex = await exportar(db, [a1, a2], { canal: "WHATSAPP" });
    expect(ex.exportados).toBe(0);
    expect(ex.ids_excluidos.map((x) => x.motivo_codigo))
      .toEqual(["contato_compartilhado", "contato_compartilhado"]);
    // e o motivo chega legivel na tela, nao como codigo cru
    expect(ex.ids_excluidos[0].motivo).toMatch(/mesmo contato/i);
  });

  it("um aluno sozinho no contato volta a ser elegivel quando o outro sai", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await mesmoContato(db, [a1, a2], { telefone: "(51) 99999-1234" });
    expect(porAluno(await universo(db, { canal: "WHATSAPP" }))[a1].disponivel).toBe(false);

    // revisao cadastral corrige o telefone do segundo: o primeiro destrava
    await db.query(`update public.alunos set telefone = '(51) 98888-7777' where id = $1`, [a2]);
    const u = porAluno(await universo(db, { canal: "WHATSAPP" }));
    expect(u[a1].disponivel).toBe(true);
    expect(u[a2].disponivel).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("A7 contatos invalidados: aluno_contatos passa a ter efeito", () => {
  it("contato marcado invalido tira o canal do envio", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    const { rows } = await db.query(`select email, telefone from public.alunos where id = $1`, [a1]);

    await db.query(
      `insert into public.aluno_contatos (aluno_id, tipo, valor, valido, motivo_invalidacao)
       values ($1, 'email', $2, false, 'nao e a pessoa')`,
      [a1, rows[0].email]);

    const mail = porAluno(await universo(db, { canal: "EMAIL" }));
    expect(mail[a1].disponivel).toBe(false);
    expect(mail[a1].motivo).toBe("contato_invalidado");
    expect(mail[a2].disponivel).toBe(true);

    // o telefone dele nao foi marcado: segue valendo
    expect(porAluno(await universo(db, { canal: "WHATSAPP" }))[a1].disponivel).toBe(true);
  });

  it("contato valido = true nao bloqueia nada", async () => {
    const db = await banco();
    const [a1] = await alunos(db, 1, {});
    const { rows } = await db.query(`select email from public.alunos where id = $1`, [a1]);
    await db.query(
      `insert into public.aluno_contatos (aluno_id, tipo, valor, valido) values ($1,'email',$2,true)`,
      [a1, rows[0].email]);
    expect(porAluno(await universo(db, { canal: "EMAIL" }))[a1].disponivel).toBe(true);
  });

  it("invalidado tem precedencia de motivo sobre compartilhado", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await mesmoContato(db, [a1, a2], { email: "doisdonos@x.local" });
    await db.query(
      `insert into public.aluno_contatos (aluno_id, tipo, valor, valido, motivo_invalidacao)
       values ($1,'email','doisdonos@x.local',false,'nao e a pessoa')`,
      [a1]);
    const mail = porAluno(await universo(db, { canal: "EMAIL" }));
    expect(mail[a1].motivo).toBe("contato_invalidado");
    expect(mail[a2].motivo).toBe("contato_compartilhado");
  });
});

// ---------------------------------------------------------------------------
describe("A7 permissoes: sinalizar e de todos, liberar e do Administrativo", () => {
  it("operador sinaliza, e a sinalizacao ja bloqueia o canal", async () => {
    const db = await banco();
    const [a1] = await alunos(db, 1, {});
    await comoOperador(db, OP_A);
    const r = (await db.query(
      `select public.contato_sinalizar_incorreto($1::uuid,'EMAIL','atende outra pessoa') r`, [a1])).rows[0].r;
    expect(r.ok).toBe(true);
    expect(r.autor).toBe(OP_A);

    await comoGestao(db);
    const mail = porAluno(await universo(db, { canal: "EMAIL" }));
    expect(mail[a1].disponivel).toBe(false);
    expect(mail[a1].motivo).toBe("contato_invalidado");
  });

  it("sinalizar exige motivo e canal valido", async () => {
    const db = await banco();
    const [a1] = await alunos(db, 1, {});
    await comoOperador(db, OP_A);
    await expect(db.query(`select public.contato_sinalizar_incorreto($1::uuid,'EMAIL','   ')`, [a1]))
      .rejects.toThrow(/Motivo obrigatorio/i);
    await expect(db.query(`select public.contato_sinalizar_incorreto($1::uuid,'CARTA','x')`, [a1]))
      .rejects.toThrow(/Canal invalido/i);
  });

  it("operador NAO revalida e NAO abre a fila; Administrativo e supervisao sim", async () => {
    const db = await banco();
    const [a1] = await alunos(db, 1, {});
    await comoOperador(db, OP_A);
    const sinal = (await db.query(
      `select public.contato_sinalizar_incorreto($1::uuid,'EMAIL','nao e a pessoa') r`, [a1])).rows[0].r;

    // operador: barrado nas duas rotas
    await expect(db.query(`select public.contato_revalidar($1::uuid,'conferi')`, [sinal.contato_id]))
      .rejects.toThrow(/exclusivo do Administrativo ou da supervisao/i);
    await expect(db.query(`select * from public.contato_fila_revisao()`))
      .rejects.toThrow(/restrita ao Administrativo e a supervisao/i);

    // supervisao: abre a fila
    await comoOperador(db, SUP);
    expect((await db.query(`select public.usuario_pode_revalidar_contato() p`)).rows[0].p).toBe(true);
    await db.query(`select * from public.contato_fila_revisao()`);

    // Administrativo: libera, e o canal volta
    await comoOperador(db, ADM);
    const lib = (await db.query(
      `select public.contato_revalidar($1::uuid,'titular confirmado por telefone') r`,
      [sinal.contato_id])).rows[0].r;
    expect(lib.ok).toBe(true);

    await comoGestao(db);
    expect(porAluno(await universo(db, { canal: "EMAIL" }))[a1].disponivel).toBe(true);
  });

  it("liberar preserva a trilha do motivo anterior e exige motivo", async () => {
    const db = await banco();
    const [a1] = await alunos(db, 1, {});
    await comoOperador(db, OP_A);
    const sinal = (await db.query(
      `select public.contato_sinalizar_incorreto($1::uuid,'EMAIL','atende a mae') r`, [a1])).rows[0].r;

    await comoOperador(db, ADM);
    await expect(db.query(`select public.contato_revalidar($1::uuid,'  ')`, [sinal.contato_id]))
      .rejects.toThrow(/Motivo obrigatorio/i);
    await db.query(`select public.contato_revalidar($1::uuid,'titular confirmado')`, [sinal.contato_id]);

    const { rows } = await db.query(
      `select valido, motivo_invalidacao from public.aluno_contatos where id = $1`, [sinal.contato_id]);
    expect(rows[0].valido).toBe(true);
    expect(rows[0].motivo_invalidacao).toMatch(/LIBERADO por adm@aelbra\.com\.br/);
    expect(rows[0].motivo_invalidacao).toMatch(/anterior: atende a mae/);
  });

  it("usuario inativo com perfil certo NAO libera (guarda devolve falso, nao nulo)", async () => {
    const db = await banco();
    await db.query(
      `insert into public.usuarios (email, nome, perfil, ativo) values ('ex@aelbra.com.br','Ex','administrativo',false)`);
    await comoOperador(db, "ex@aelbra.com.br");
    expect((await db.query(`select public.usuario_pode_revalidar_contato() p`)).rows[0].p).toBe(false);
    // e um e-mail que nao existe em usuarios tambem da falso, nao nulo
    await comoOperador(db, "ninguem@aelbra.com.br");
    expect((await db.query(`select public.usuario_pode_revalidar_contato() p`)).rows[0].p).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("A7 fila de revisao cadastral", () => {
  it("lista o contato compartilhado, prioriza >= 5 pessoas e diz quem tem canal alternativo", async () => {
    const db = await banco();
    const dois = await alunos(db, 2, {});
    const cinco = await alunos(db, 5, { ini: 10 });
    await mesmoContato(db, dois, { telefone: "(51) 99999-1111" });
    await mesmoContato(db, cinco, { telefone: "(51) 99999-5555" });

    await comoOperador(db, ADM);
    const fila = (await db.query(`select * from public.contato_fila_revisao('TELEFONE')`)).rows;
    expect(fila.length).toBe(2);
    // prioritario primeiro
    expect(fila[0].pessoas).toBe(5);
    expect(fila[0].revisao_prioritaria).toBe(true);
    expect(fila[1].pessoas).toBe(2);
    expect(fila[1].revisao_prioritaria).toBe(false);
    // o limite de 5 so PRIORIZA: o de 2 pessoas tambem esta na fila (R5)
    expect(fila[1].alunos.length).toBe(2);
    // ambos tem e-mail proprio, logo canal alternativo
    expect(fila[1].alunos.every((x) => x.tem_canal_alternativo)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("A7 bordas que decidem o desenho", () => {
  it("ficha duplicada do MESMO CPF nao e colisao", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await mesmoContato(db, [a1, a2], { telefone: "(51) 99999-1234" });
    // mesma pessoa em duas fichas
    await db.query(`update public.alunos set cpf = '11122233344' where id = any($1::uuid[])`, [[a1, a2]]);
    const u = porAluno(await universo(db, { canal: "WHATSAPP" }));
    expect(u[a1].disponivel).toBe(true);
    expect(u[a2].disponivel).toBe(true);
  });

  // R6: placeholder nao conta como COLISAO -- nao ha terceiro a proteger num
  // numero que nao e de ninguem. O A7 para aqui, de proposito.
  //
  // E o que este teste DOCUMENTA, e nao corrige: o universo de hoje considera
  // qualquer telefone nao nulo como contato valido (`f_tel` so testa nao-nulo),
  // entao 99999999999 continua recebendo envio. Medido em producao em
  // 22/10/2026: 30 alunos com saldo tem telefone de digito repetido e 784 tem
  // telefone com tamanho invalido (diferente de 10 ou 11 digitos). Bloquear
  // esses ~814 e mudanca de alcance que a gestao NAO autorizou no A7 -- fica
  // registrado como achado, nao entra aqui.
  it("placeholder compartilhado NAO e tratado como colisao (e o A7 nao o bloqueia)", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await mesmoContato(db, [a1, a2], { telefone: "(99) 99999-9999" });
    const u = porAluno(await universo(db, { canal: "WHATSAPP" }));
    expect(u[a1].motivo).toBeNull();
    expect(u[a2].motivo).toBeNull();
    expect(u[a1].disponivel).toBe(true);
    expect(u[a2].disponivel).toBe(true);
    // a prova de que o A7 nao os considerou compartilhados: nao ha linha de
    // bloqueio para eles
    const { rows } = await db.query(
      `select count(*)::int n from public.vw_contato_bloqueio where aluno_id = any($1::uuid[])`,
      [[a1, a2]]);
    expect(rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("A7 porta 2 (tela de Gmail): trocar de porta nao contorna", () => {
  it("e-mail compartilhado sai da lista de candidatos", async () => {
    const db = await banco();
    const [a1, a2, a3] = await alunos(db, 3, {});
    await mesmoContato(db, [a1, a2], { email: "doisdonos@x.local" });
    const ids = (await porta2(db)).map((r) => r.id);
    expect(ids).not.toContain(a1);
    expect(ids).not.toContain(a2);
    expect(ids).toContain(a3);
  });

  it("e-mail invalidado sai da lista de candidatos", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    const { rows } = await db.query(`select email from public.alunos where id = $1`, [a1]);
    await db.query(
      `insert into public.aluno_contatos (aluno_id, tipo, valor, valido, motivo_invalidacao)
       values ($1,'email',$2,false,'nao e a pessoa')`, [a1, rows[0].email]);
    const ids = (await porta2(db)).map((r) => r.id);
    expect(ids).not.toContain(a1);
    expect(ids).toContain(a2);
  });

  it("telefone bloqueado sai NULO, mesmo quando o aluno segue na lista por e-mail", async () => {
    const db = await banco();
    const [a1, a2, a3] = await alunos(db, 3, {});
    await mesmoContato(db, [a1, a2], { telefone: "(51) 99999-1234" });
    const porId = Object.fromEntries((await porta2(db)).map((r) => [r.id, r]));
    // seguem na lista: o e-mail de cada um e proprio
    expect(porId[a1]).toBeDefined();
    expect(porId[a2]).toBeDefined();
    // mas o telefone compartilhado nao sai da funcao
    expect(porId[a1].telefone).toBeNull();
    expect(porId[a2].telefone).toBeNull();
    expect(porId[a3].telefone).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("A7 ausencia de regressao", () => {
  it("contato proprio continua elegivel, exportavel e com os mesmos motivos", async () => {
    const db = await banco();
    const limpos = await alunos(db, 3, {});
    // um de cada motivo que ja existia antes do A7
    const [comRetorno] = await alunos(db, 1, { ini: 20, retornoEmDias: 5 });
    await db.query(`update public.alunos set retorno_origem = 'OPERADOR' where id = $1`, [comRetorno]);
    const [emConfirmacao] = await alunos(db, 1, { ini: 30, confirmacao: true });
    const [semTel] = await alunos(db, 1, { ini: 40, semTelefone: true });

    const u = porAluno(await universo(db, { canal: "WHATSAPP" }));
    for (const id of limpos) expect(u[id].disponivel).toBe(true);
    expect(u[comRetorno].motivo).toBe("retorno_futuro");
    expect(u[emConfirmacao].motivo).toBe("confirmacao_pendente");
    expect(u[semTel].motivo).toBe("contato_indisponivel");

    const ex = await exportar(db, limpos, { canal: "WHATSAPP" });
    expect(ex.exportados).toBe(3);
  });

  it("a previa entrega os mesmos elegiveis quando ninguem compartilha contato", async () => {
    const db = await banco();
    const ids = await alunos(db, 6, {});
    const p = await previa(db, { p_canal: "WHATSAPP", p_limite: 10 });
    expect(p.elegiveis.length).toBe(6);
    expect(new Set(p.elegiveis.map((e) => e.id))).toEqual(new Set(ids));
  });

  it("as views do A7 nao ficam legiveis por authenticated nem anon", async () => {
    const db = await banco();
    const { rows } = await db.query(
      `select table_name, grantee from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name like 'vw_contato%'
          and grantee in ('authenticated','anon')`);
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rollback que nunca foi executado nao e rollback. Este teste roda o arquivo
// de rollback de verdade e confere que (a) ele aplica sem erro, (b) o bloqueio
// sai, (c) as marcas em aluno_contatos PERMANECEM -- zero DML, como declarado.
describe("A7 rollback", () => {
  it("desfaz o bloqueio, preserva as marcas e nao deixa objeto orfao", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await mesmoContato(db, [a1, a2], { telefone: "(51) 99999-1234" });
    await comoOperador(db, OP_A);
    const sinal = (await db.query(
      `select public.contato_sinalizar_incorreto($1::uuid,'EMAIL','nao e a pessoa') r`, [a1])).rows[0].r;
    await comoGestao(db);
    expect(porAluno(await universo(db, { canal: "WHATSAPP" }))[a1].disponivel).toBe(false);

    await db.exec(RB_A7);

    // (b) o bloqueio saiu: os dois voltam a ser elegiveis nos dois canais
    for (const canal of ["WHATSAPP", "EMAIL"]) {
      const u = porAluno(await universo(db, { canal }));
      expect(u[a1].disponivel, canal).toBe(true);
      expect(u[a2].disponivel, canal).toBe(true);
    }
    // a porta 2 tambem volta ao comportamento anterior
    const ids = (await porta2(db)).map((r) => r.id);
    expect(ids).toContain(a1);

    // (c) a marca do operador continua gravada -- o rollback nao apaga dado
    const { rows } = await db.query(
      `select valido, motivo_invalidacao from public.aluno_contatos where id = $1`, [sinal.contato_id]);
    expect(rows[0].valido).toBe(false);
    expect(rows[0].motivo_invalidacao).toBe("nao e a pessoa");

    // (d) nenhuma view do A7 sobrou
    const { rows: sobra } = await db.query(
      `select table_name from information_schema.views
        where table_schema = 'public' and table_name like 'vw_contato%'`);
    expect(sobra).toEqual([]);
  });
});
