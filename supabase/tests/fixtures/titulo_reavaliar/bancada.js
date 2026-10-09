// Bancada de `titulo_reavaliar`: PostgreSQL real (PGlite) com o esqueleto das
// tabelas que a função lê, os gatilhos de produção sobre `acordos`, e a
// migration estrutural de 24/09 aplicada por cima — a mesma que está em
// supabase/aguardando_aprovacao/, lida do arquivo, não copiada.
//
// Dados FICTÍCIOS. O que se prova é a regra.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const lerRepo = (p) => readFileSync(resolve(AQUI, "..", "..", "..", "..", p), "utf8");

export const ESTRUTURAL =
  "supabase/aguardando_aprovacao/20260924_1_estrutural_mensalidade_segue_status_do_acordo.sql.pendente";

export const q1 = async (db, sql, p = []) => (await db.query(sql, p)).rows[0];
export const qn = async (db, sql, p = []) => (await db.query(sql, p)).rows;

const ESQUELETO = `
create table public.acordos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid, cpf text, status text, numero_acordo bigint,
  valor_total numeric, qtd_parcelas integer,
  operador_responsavel_email text, operador_responsavel_nome text,
  criado_em timestamptz default now(), atualizado_em timestamptz default now()
);

create table public.acordos_titulos (
  id uuid primary key default gen_random_uuid(),
  aluno_id uuid, cpf text, documento text, vencimento date,
  valor_original numeric, valor_em_aberto numeric, saldo_corrigido numeric,
  situacao text, status text, tipo_boleto text, acordo_id uuid,
  motivo_ajuste text,
  origem_liquidacao text, origem_liquidacao_ref text, origem_liquidacao_em timestamptz,
  origem_encerramento text, origem_encerramento_ref text, origem_encerramento_em timestamptz,
  created_at timestamp default now(), atualizado_em timestamptz default now()
);

create table public.acordo_titulo_vinculo (
  titulo_id uuid, acordo_id uuid, ativo boolean default true,
  criado_em timestamptz default now()
);

create table public.parcelas (
  id uuid primary key default gen_random_uuid(),
  acordo_id uuid, numero integer, valor numeric, vencimento date, status text,
  boleto text, pago_em timestamptz
);

create table public.pagamentos (
  id uuid primary key default gen_random_uuid(),
  titulo_numero text, valor_pago numeric
);

create table public.conferencia_pagamentos (
  id uuid primary key default gen_random_uuid(),
  titulo_numero text
);

create table public.solicitacoes_confirmacao_pagamento (
  id uuid primary key default gen_random_uuid(),
  titulo_id uuid, status text
);

-- Gatilho de coerência de produção: quando a situação vira PAGO e o status não
-- foi escrito junto, ele acerta o status. É ele que explica a variante
-- "atualizado_em, situacao" da assinatura A2.
create or replace function public._titulo_situacao_e_status_coerentes() returns trigger
language plpgsql as $$
begin
  if upper(coalesce(new.situacao,'')) = 'PAGO' and lower(coalesce(new.status,'')) <> 'quitada' then
    new.status := 'quitada';
  elsif upper(coalesce(new.situacao,'')) = 'NEGOCIADO' and lower(coalesce(new.status,'')) not in ('vinculada') then
    new.status := 'vinculada';
  end if;
  return new;
end $$;
create trigger trg_titulo_situacao_e_status_coerentes
  before insert or update of situacao on public.acordos_titulos
  for each row execute function public._titulo_situacao_e_status_coerentes();
`;

// Os três gatilhos de produção sobre `acordos`, nos mesmos nomes.
const GATILHOS = `
create trigger trg_titulo_quita_com_o_acordo
  after update of status on public.acordos
  for each row execute function public._titulo_quita_com_o_acordo();

create trigger trg_titulos_por_status_acordo
  after update of status on public.acordos
  for each row execute function public.titulos_por_status_acordo();

create or replace function public._acordo_status_reavalia_titulos() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid;
begin
  for v_id in
    select t.id from public.acordos_titulos t where t.acordo_id = new.id
    union
    select v.titulo_id from public.acordo_titulo_vinculo v where v.acordo_id = new.id
  loop
    perform public.titulo_reavaliar(v_id);
  end loop;
  return new;
end $$;

create trigger trg_acordo_status_reavalia_titulos
  after update of status on public.acordos
  for each row
  when (upper(coalesce(old.status,'')) is distinct from upper(coalesce(new.status,'')))
  execute function public._acordo_status_reavalia_titulos();
`;

let DESPEJO = null;

async function construir() {
  const db = new PGlite();
  await db.exec(ESQUELETO);
  // a migration estrutural entra DEPOIS do esqueleto: ela acrescenta as três
  // colunas de proveniência e substitui as três funções.
  await db.exec(lerRepo(ESTRUTURAL));
  await db.exec(GATILHOS);
  await db.exec("set timezone = 'UTC'");
  return db;
}

export async function montar() {
  if (!DESPEJO) {
    const base = await construir();
    DESPEJO = await base.dumpDataDir();
    await base.close();
  }
  const db = new PGlite({ loadDataDir: DESPEJO });
  await db.exec("set timezone = 'UTC'");
  return db;
}

// Um acordo com um título vinculado. `quitado` monta o cenário já pós-quitação:
// título PAGO com proveniência gravada, como o saneamento deixaria.
export async function semear(db, {
  numero = 100,
  statusAcordo = "QUITADO",
  situacaoTitulo = "PAGO",
  statusTitulo = "quitada",
  tipoBoleto = null,
  documento = "4200001",
  valor = 500,
  proveniencia = "ACORDO",          // 'ACORDO' | null
  provenienciaDeOutroAcordo = false,
  parcelaViva = false,
  origemLiquidacao = null,
  comPagamento = false,
  comConferencia = false,
  comSolicitacao = false,
} = {}) {
  const acordo = (await q1(db,
    "insert into public.acordos (status, numero_acordo, valor_total) values ($1,$2,$3) returning id",
    [statusAcordo, numero, valor])).id;

  const outro = provenienciaDeOutroAcordo
    ? (await q1(db, "insert into public.acordos (status, numero_acordo) values ('ATIVO', 999) returning id")).id
    : null;

  await db.query(
    "insert into public.parcelas (acordo_id, numero, valor, status) values ($1, 1, $2, $3)",
    [acordo, valor, parcelaViva ? "A_VENCER" : "PAGO"]);

  const titulo = (await q1(db, `
    insert into public.acordos_titulos
      (documento, situacao, status, tipo_boleto, acordo_id, valor_original,
       saldo_corrigido, valor_em_aberto, origem_liquidacao,
       quitacao_origem, quitacao_origem_acordo_id, quitacao_origem_em)
    values ($1,$2,$3,$4::text,$5,$6,$6,$6,$7::text,$8::text,$9, case when $8::text is null then null else now() end)
    returning id`,
    [documento, situacaoTitulo, statusTitulo, tipoBoleto, acordo, valor,
     origemLiquidacao, proveniencia, proveniencia ? (outro ?? acordo) : null])).id;

  await db.query("insert into public.acordo_titulo_vinculo (titulo_id, acordo_id) values ($1,$2)", [titulo, acordo]);

  if (comPagamento) await db.query("insert into public.pagamentos (titulo_numero) values ($1)", [documento]);
  if (comConferencia) await db.query("insert into public.conferencia_pagamentos (titulo_numero) values ($1)", [documento]);
  if (comSolicitacao) await db.query("insert into public.solicitacoes_confirmacao_pagamento (titulo_id) values ($1)", [titulo]);

  return { acordo, titulo, outro };
}

// Muda o status do acordo — é o gatilho de produção que chama titulo_reavaliar.
export const mudarStatusDoAcordo = (db, acordo, status) =>
  db.query("update public.acordos set status = $2, atualizado_em = now() where id = $1", [acordo, status]);

export const estadoDoTitulo = (db, titulo) =>
  q1(db, `select situacao, status, acordo_id, quitacao_origem, quitacao_origem_acordo_id,
                 saldo_corrigido, valor_em_aberto, motivo_ajuste
            from public.acordos_titulos where id = $1`, [titulo]);
