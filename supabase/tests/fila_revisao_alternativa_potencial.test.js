// FILA DE REVISAO CADASTRAL: `alternativa_potencial` e `acao_sugerida`.
//
// PostgreSQL real (PGlite), sobre a bancada das Acoes Massivas + a migration do
// A7 + a desta frente. Carteira 100% inventada.
//
// As TRES formas que a analise dos 84 alunos sem canal encontrou em producao em
// 22/10/2026, e que este arquivo reproduz:
//
//   15 fichas  -- tem contato cadastrado em `aluno_contatos` que talvez sirva:
//                 valido, diferente do da ficha, nao placeholder e que NAO esta
//                 na ficha de mais ninguem  -> CONFERIR_E_PROMOVER
//    3 fichas  -- tem contato cadastrado, mas ele JA ESTA na ficha de outra
//                 pessoa: promover criaria colisao nova -> CONFERIR_TITULARIDADE
//   66 fichas  -- nao tem alternativa nenhuma              -> CONFERIR_TITULARIDADE
//
// O que este arquivo PROVA, alem da classificacao: que `alternativa_potencial`
// nao e promessa de titularidade (so de ausencia de colisao), que o portao de
// permissao continua recusando operador, que `tem_canal_alternativo` nao
// regrediu, e que a funcao nao voltou a usar `exists` correlacionado.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { novoBanco as bancadaBase, alunos, comoGestao, comoOperador, OP_A } from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ler = (p) => readFileSync(resolve(RAIZ, p), "utf8");
const MIG_A7 = ler("supabase/migrations/20261022120000_a7_contato_compartilhado_bloqueia_massiva.sql");
const MIG_FILA = ler("supabase/migrations/20261023090000_fila_revisao_alternativa_potencial.sql");
const RB_FILA = ler("supabase/rollbacks/20261023090000_fila_revisao_alternativa_potencial.rollback.sql");

// Pecas que a bancada do universo nao tem. Os corpos de
// `aluno_contato_*` sao os REAIS de producao (pg_get_functiondef, 22/10/2026),
// porque a migration do A7 os patcheia por ancora -- se divergirem, falha aqui.
const EXTRA = `
  create table public.aluno_contatos (
    id uuid primary key default gen_random_uuid(),
    aluno_id uuid, tipo text, valor text, valor_exibicao text, origem text,
    principal boolean, valido boolean default true,
    invalidado_em timestamptz, invalidado_por_email text, motivo_invalidacao text,
    criado_em timestamptz default now(), criado_por_email text);
  create or replace function public.aluno_em_confirmacao_pagamento(p_id text)
  returns text language sql stable as $$ select null::text $$;
  create or replace function public.app_usuario_ativo()
  returns boolean language sql stable security definer set search_path to 'public' as $$
    select exists (select 1 from public.usuarios u
                    where lower(u.email) = lower(coalesce((auth.jwt() ->> 'email'), '')) and u.ativo is true)
  $$;
  create or replace function public.aluno_contatos_sincronizar(p_aluno_id uuid)
  returns void language plpgsql security definer set search_path to 'public' as $$
  begin
    update public.alunos a set telefone = (
      select coalesce(c.valor_exibicao, c.valor) from public.aluno_contatos c
       where c.aluno_id = a.id and lower(c.tipo) = 'telefone' and c.valido
       order by c.criado_em, c.id limit 1)
     where a.id = p_aluno_id
       and exists (select 1 from public.aluno_contatos c where c.aluno_id = a.id and lower(c.tipo) = 'telefone');
  end $$;
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
CREATE OR REPLACE FUNCTION public.aluno_contato_invalidar(p_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(coalesce(auth.email(),''));
  v_aluno uuid;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE='42501';
  END IF;

  UPDATE public.aluno_contatos
     SET valido = false, principal = false, invalidado_em = now(),
         invalidado_por_email = nullif(v_email,''),
         motivo_invalidacao = nullif(trim(coalesce(p_motivo,'')),'')
   WHERE id = p_id AND valido
   RETURNING aluno_id INTO v_aluno;

  IF v_aluno IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'NAO_ENCONTRADO_OU_JA_INVALIDO');
  END IF;

  PERFORM public.aluno_contatos_sincronizar(v_aluno);
  RETURN jsonb_build_object('ok', true, 'aluno_id', v_aluno);
END;
$function$;
CREATE OR REPLACE FUNCTION public.aluno_contato_revalidar(p_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_aluno uuid;
BEGIN
  IF coalesce(auth.role(),'') <> 'service_role' AND NOT public.app_usuario_ativo() THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE='42501';
  END IF;

  UPDATE public.aluno_contatos
     SET valido = true, invalidado_em = null, invalidado_por_email = null, motivo_invalidacao = null
   WHERE id = p_id AND NOT valido
   RETURNING aluno_id INTO v_aluno;

  IF v_aluno IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'NAO_ENCONTRADO_OU_JA_VALIDO');
  END IF;

  PERFORM public.aluno_contatos_sincronizar(v_aluno);
  RETURN jsonb_build_object('ok', true, 'aluno_id', v_aluno);
END;
$function$;
`;

// A tela guarda telefone com o DDI 55 na frente -- por isso a chave de
// comparacao tira o DDI. Ver contato_tel_sem_ddi.
const comDdi = (tel) => "55" + String(tel).replace(/\D/g, "");

const ADM = "adm@aelbra.com.br";

async function banco() {
  const db = await bancadaBase();
  await db.exec(EXTRA);
  await db.exec(MIG_A7);
  await db.exec(MIG_FILA);
  await db.query(
    `insert into public.usuarios (email, nome, perfil, ativo) values ($1,'Administrativo','administrativo',true)`,
    [ADM]);
  await comoGestao(db);
  return db;
}

const setTel = (db, ids, tel) =>
  db.query(`update public.alunos set telefone = $2 where id = any($1::uuid[])`, [ids, tel]);

/** Cadastra um contato em aluno_contatos, como a tela cadastra. */
const addContato = (db, alunoId, canal, valor, { valido = true } = {}) =>
  db.query(
    `insert into public.aluno_contatos (aluno_id, tipo, valor, valor_exibicao, origem, principal, valido)
     values ($1, $2, $3, $4, 'TESTE', false, $5)`,
    [alunoId, canal === "TELEFONE" ? "telefone" : "email",
     canal === "TELEFONE" ? comDdi(valor) : valor, valor, valido]);

async function fila(db, canal = null) {
  const { rows } = await db.query(`select * from public.contato_fila_revisao($1, 500)`, [canal]);
  return rows;
}
/** Mapa aluno_id -> objeto da ficha, achatando todas as linhas da fila. */
const porFicha = (rows) =>
  Object.fromEntries(rows.flatMap((r) => (r.alunos || []).map((a) => [a.aluno_id, a])));

// ---------------------------------------------------------------------------
describe("fila de revisao: as tres formas dos 84", () => {
  it("FORMA 1 (os 15): contato cadastrado que nao esta em ficha de ninguem => CONFERIR_E_PROMOVER", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await setTel(db, [a1, a2], "(51) 99999-1234");   // colisao
    await addContato(db, a1, "TELEFONE", "(51) 98888-0001"); // alternativa livre

    await comoOperador(db, ADM);
    const f = porFicha(await fila(db, "TELEFONE"));
    expect(f[a1].alternativa_potencial).toBe(true);
    expect(f[a1].acao_sugerida).toBe("CONFERIR_E_PROMOVER");
    // o outro da colisao nao tem alternativa: segue conferencia
    expect(f[a2].alternativa_potencial).toBe(false);
    expect(f[a2].acao_sugerida).toBe("CONFERIR_TITULARIDADE");
  });

  it("FORMA 2 (os 3): alternativa JA ESTA na ficha de outra pessoa => CONFERIR_TITULARIDADE", async () => {
    const db = await banco();
    const [a1, a2, a3] = await alunos(db, 3, {});
    await setTel(db, [a1, a2], "(51) 99999-1234");   // colisao
    await setTel(db, [a3], "(51) 97777-5555");       // ficha de terceiro
    // a unica alternativa de a1 e justamente o numero do a3
    await addContato(db, a1, "TELEFONE", "(51) 97777-5555");

    await comoOperador(db, ADM);
    const f = porFicha(await fila(db, "TELEFONE"));
    expect(f[a1].alternativa_potencial).toBe(false);
    expect(f[a1].acao_sugerida).toBe("CONFERIR_TITULARIDADE");
  });

  it("FORMA 3 (os 66): nenhuma alternativa cadastrada => CONFERIR_TITULARIDADE", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await setTel(db, [a1, a2], "(51) 99999-1234");

    await comoOperador(db, ADM);
    const f = porFicha(await fila(db, "TELEFONE"));
    for (const id of [a1, a2]) {
      expect(f[id].alternativa_potencial, id).toBe(false);
      expect(f[id].acao_sugerida, id).toBe("CONFERIR_TITULARIDADE");
    }
  });

  it("as tres formas convivem na mesma fila, com a contagem certa", async () => {
    const db = await banco();
    // 4 colisoes de 2, uma de cada forma + uma mista
    const ids = await alunos(db, 8, {});
    const [p1a, p1b, p2a, p2b, p3a, p3b, extra1, extra2] = ids;
    await setTel(db, [p1a, p1b], "(51) 99991-0001");
    await setTel(db, [p2a, p2b], "(51) 99992-0002");
    await setTel(db, [p3a, p3b], "(51) 99993-0003");
    await setTel(db, [extra1], "(51) 97777-7777");
    await setTel(db, [extra2], "(51) 96666-6666");

    await addContato(db, p1a, "TELEFONE", "(51) 98881-0001");   // FORMA 1
    await addContato(db, p2a, "TELEFONE", "(51) 97777-7777");   // FORMA 2 (e do extra1)
    // p3a/p3b sem nada                                          // FORMA 3

    await comoOperador(db, ADM);
    const f = porFicha(await fila(db, "TELEFONE"));
    const comAlternativa = Object.values(f).filter((x) => x.alternativa_potencial).map((x) => x.aluno_id);
    expect(comAlternativa).toEqual([p1a]);
    expect(Object.keys(f).length).toBe(6); // so os 6 presos em colisao
    expect(Object.values(f).filter((x) => x.acao_sugerida === "CONFERIR_TITULARIDADE").length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
describe("fila de revisao: o que NAO conta como alternativa", () => {
  it("contato invalidado nao conta", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await setTel(db, [a1, a2], "(51) 99999-1234");
    await addContato(db, a1, "TELEFONE", "(51) 98888-0001", { valido: false });
    await comoOperador(db, ADM);
    expect(porFicha(await fila(db, "TELEFONE"))[a1].alternativa_potencial).toBe(false);
  });

  it("placeholder nao conta", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await setTel(db, [a1, a2], "(51) 99999-1234");
    await addContato(db, a1, "TELEFONE", "(99) 99999-9999"); // digito repetido
    await comoOperador(db, ADM);
    expect(porFicha(await fila(db, "TELEFONE"))[a1].alternativa_potencial).toBe(false);
  });

  it("contato igual ao que ja esta na ficha nao conta", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await setTel(db, [a1, a2], "(51) 99999-1234");
    await addContato(db, a1, "TELEFONE", "(51) 99999-1234"); // o proprio, com DDI
    await comoOperador(db, ADM);
    expect(porFicha(await fila(db, "TELEFONE"))[a1].alternativa_potencial).toBe(false);
  });

  it("alternativa compartilhada entre duas pessoas nao conta", async () => {
    const db = await banco();
    const [a1, a2, a3, a4] = await alunos(db, 4, {});
    await setTel(db, [a1, a2], "(51) 99999-1234");
    await setTel(db, [a3, a4], "(51) 95555-4444"); // esse par ja colide entre si
    await addContato(db, a1, "TELEFONE", "(51) 95555-4444");
    await comoOperador(db, ADM);
    expect(porFicha(await fila(db, "TELEFONE"))[a1].alternativa_potencial).toBe(false);
  });

  it("e-mail tambem vale como alternativa", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await setTel(db, [a1, a2], "(51) 99999-1234");
    await addContato(db, a1, "EMAIL", "novo.endereco@aluno.local");
    await comoOperador(db, ADM);
    expect(porFicha(await fila(db, "TELEFONE"))[a1].alternativa_potencial).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("fila de revisao: nada regrediu", () => {
  it("tem_canal_alternativo segue com o significado anterior", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    // telefone compartilhado, e-mail proprio: o e-mail e canal alternativo
    await setTel(db, [a1, a2], "(51) 99999-1234");
    await comoOperador(db, ADM);
    const f = porFicha(await fila(db, "TELEFONE"));
    expect(f[a1].tem_canal_alternativo).toBe(true);

    // agora sem e-mail: nao ha canal alternativo
    await comoGestao(db);
    await db.query(`update public.alunos set email = null where id = any($1::uuid[])`, [[a1, a2]]);
    await comoOperador(db, ADM);
    expect(porFicha(await fila(db, "TELEFONE"))[a1].tem_canal_alternativo).toBe(false);
  });

  it("portao de permissao continua recusando operador", async () => {
    const db = await banco();
    await comoOperador(db, OP_A);
    await expect(db.query(`select * from public.contato_fila_revisao()`))
      .rejects.toThrow(/restrita ao Administrativo e a supervisao/i);
  });

  it("ordem e limite preservados: prioritario primeiro", async () => {
    const db = await banco();
    const dois = await alunos(db, 2, {});
    const cinco = await alunos(db, 5, { ini: 20 });
    await setTel(db, dois, "(51) 99991-1111");
    await setTel(db, cinco, "(51) 99995-5555");
    await comoOperador(db, ADM);
    const rows = await fila(db, "TELEFONE");
    expect(rows.length).toBe(2);
    expect(rows[0].pessoas).toBe(5);
    expect(rows[0].revisao_prioritaria).toBe(true);
    expect(rows[1].pessoas).toBe(2);
  });

  it("a funcao NAO usa exists correlacionado contra as views pesadas", async () => {
    const db = await banco();
    const { rows } = await db.query(
      `select lower(pg_get_functiondef(p.oid)) d from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='contato_fila_revisao'`);
    expect(rows[0].d).not.toMatch(/exists \(select 1 from public\.vw_contato/);
    expect(rows[0].d).toMatch(/materialized/);
  });

  it("nao escreve nada: fila e leitura pura", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await setTel(db, [a1, a2], "(51) 99999-1234");
    await addContato(db, a1, "TELEFONE", "(51) 98888-0001");
    const antes = await db.query(
      `select (select count(*) from public.aluno_contatos) c,
              (select count(*) from public.alunos where telefone is not null) t,
              (select md5(string_agg(id::text||coalesce(telefone,''), '|' order by id)) from public.alunos) h`);
    await comoOperador(db, ADM);
    await fila(db, null);
    await comoGestao(db);
    const depois = await db.query(
      `select (select count(*) from public.aluno_contatos) c,
              (select count(*) from public.alunos where telefone is not null) t,
              (select md5(string_agg(id::text||coalesce(telefone,''), '|' order by id)) from public.alunos) h`);
    expect(depois.rows[0]).toEqual(antes.rows[0]);
  });
});

// ---------------------------------------------------------------------------
describe("fila de revisao: rollback", () => {
  it("volta ao corpo do A7, sem os campos novos, e a fila continua servindo", async () => {
    const db = await banco();
    const [a1, a2] = await alunos(db, 2, {});
    await setTel(db, [a1, a2], "(51) 99999-1234");
    await addContato(db, a1, "TELEFONE", "(51) 98888-0001");

    await comoOperador(db, ADM);
    expect(porFicha(await fila(db, "TELEFONE"))[a1].alternativa_potencial).toBe(true);

    await comoGestao(db);
    await db.exec(RB_FILA);

    await comoOperador(db, ADM);
    const f = porFicha(await fila(db, "TELEFONE"));
    expect(f[a1].alternativa_potencial).toBeUndefined();
    expect(f[a1].acao_sugerida).toBeUndefined();
    // o que existia antes segue existindo
    expect(f[a1].tem_canal_alternativo).toBe(true);
    expect(f[a1].nome).toBeTruthy();
  });
});
