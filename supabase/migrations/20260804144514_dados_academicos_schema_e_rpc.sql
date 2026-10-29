-- Dados Acadêmicos: enriquecer alunos com CURSO REAL e SITUAÇÃO ACADÊMICA
-- vindos do "Relatório de Inadimplência" do sistema acadêmico.
--
-- REGRAS DE OURO (decisão Amanda 2026-08-04):
--  * Este fluxo SÓ enriquece aluno que JÁ EXISTE (apenas UPDATE, nunca INSERT).
--  * NÃO cria aluno, NÃO cria título, NÃO toca em saldo/acordo/financeiro/modalidade.
--  * `alunos.curso` (=modalidade) é PRESERVADO. Curso real vai em coluna nova `curso_real`.
--  * Idempotente: reimportar o mesmo arquivo dá o mesmo resultado (só UPDATE), zero duplicação.
--  * Só grava quando há valor novo (coalesce), nunca apaga o que já existe.

create extension if not exists unaccent;

-- 1) Colunas novas (não destrutivas) --------------------------------------
alter table alunos
  add column if not exists curso_real text,
  add column if not exists situacao_academica text,
  add column if not exists academico_codigo text,
  add column if not exists academico_fonte text,
  add column if not exists academico_atualizado_em timestamptz;

comment on column alunos.curso_real is 'Nome do curso real (ex: DIREITO) vindo do relatório acadêmico. NÃO confundir com alunos.curso, que é a modalidade.';
comment on column alunos.academico_codigo is 'Código/matrícula acadêmica do sistema (ex: 2026003152). Não é a matrícula interna do CRM.';

-- 2) Log de importações acadêmicas (auditoria + pendências) ----------------
create table if not exists academico_importacoes (
  id uuid primary key default gen_random_uuid(),
  fonte text,
  arquivo text,
  total int,
  casados int,
  pendentes jsonb default '[]'::jsonb,
  criado_por text,
  criado_em timestamptz default now()
);

alter table academico_importacoes enable row level security;
-- leitura/escrita só via RPC (security definer); deny-all direto.
drop policy if exists academico_importacoes_deny on academico_importacoes;
create policy academico_importacoes_deny on academico_importacoes for all using (false) with check (false);

-- 3) Normalizador de texto (para casar por nome/estabelecimento) -----------
create or replace function acad_norm_txt(t text)
returns text language sql stable as $$
  select nullif(lower(regexp_replace(unaccent(coalesce(t,'')), '\s+', ' ', 'g')), '');
$$;

-- 4) RPC de importação -----------------------------------------------------
create or replace function importar_dados_academicos(
  p_linhas jsonb,
  p_fonte text default 'relatorio_inadimplencia',
  p_arquivo text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email     text := lower(coalesce(auth.jwt()->>'email',''));
  v_row       jsonb;
  v_cpf       text;
  v_nome      text;
  v_unid      text;
  v_curso     text;
  v_sit       text;
  v_codigo    text;
  v_ids       uuid[];
  v_id        uuid;
  v_total     int := 0;
  v_casados   int := 0;
  v_curso_upd int := 0;
  v_sit_upd   int := 0;
  v_pendentes jsonb := '[]'::jsonb;
begin
  -- gate: só gestão (Amanda gestora, Fernanda cobranca04, Amanda ADM cobranca07)
  if v_email not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br') then
    raise exception 'Acesso restrito à gestão';
  end if;

  for v_row in select value from jsonb_array_elements(coalesce(p_linhas,'[]'::jsonb))
  loop
    v_total  := v_total + 1;
    v_ids    := null;
    v_cpf    := regexp_replace(coalesce(v_row->>'cpf',''), '\D', '', 'g');
    v_nome   := acad_norm_txt(v_row->>'nome');
    v_unid   := acad_norm_txt(v_row->>'estabelecimento');
    v_curso  := nullif(btrim(v_row->>'curso'), '');
    v_sit    := nullif(btrim(v_row->>'situacao'), '');
    v_codigo := nullif(btrim(v_row->>'codigo'), '');

    -- Chave 1: CPF (quando o relatório trouxer) — mais forte
    if length(v_cpf) >= 11 then
      select array_agg(id) into v_ids
        from alunos
       where regexp_replace(coalesce(cpf,''), '\D', '', 'g') = v_cpf;
    end if;

    -- Chave 2: e-mail (a célula pode ter vários e-mails separados por ; , ou espaço)
    if v_ids is null or array_length(v_ids,1) is null then
      with cand as (
        select distinct lower(btrim(e)) e
          from unnest(regexp_split_to_array(coalesce(v_row->>'email',''), '[;,\s]+')) e
         where e like '%@%'
      )
      select array_agg(distinct a.id) into v_ids
        from alunos a
        join cand c on lower(a.email) = c.e;
    end if;

    -- Chave 3: nome + estabelecimento (estabelecimento desambigua homônimos)
    if (v_ids is null or array_length(v_ids,1) is null) and v_nome is not null then
      select array_agg(id) into v_ids
        from alunos
       where acad_norm_txt(nome) = v_nome
         and (v_unid is null or acad_norm_txt(unidade) = v_unid);
    end if;

    if v_ids is not null and array_length(v_ids,1) = 1 then
      v_id := v_ids[1];
      update alunos set
        curso_real              = coalesce(v_curso, curso_real),
        situacao_academica      = coalesce(v_sit, situacao_academica),
        academico_codigo        = coalesce(v_codigo, academico_codigo),
        academico_fonte         = p_fonte,
        academico_atualizado_em = now()
      where id = v_id;
      v_casados := v_casados + 1;
      if v_curso is not null then v_curso_upd := v_curso_upd + 1; end if;
      if v_sit   is not null then v_sit_upd   := v_sit_upd   + 1; end if;
    else
      v_pendentes := v_pendentes || jsonb_build_object(
        'codigo',         v_codigo,
        'nome',           v_row->>'nome',
        'email',          v_row->>'email',
        'estabelecimento',v_row->>'estabelecimento',
        'curso',          v_curso,
        'situacao',       v_sit,
        'motivo', case
                    when v_ids is null or array_length(v_ids,1) is null then 'nao_encontrado'
                    else 'ambiguo'
                  end
      );
    end if;
  end loop;

  -- auditoria
  insert into academico_importacoes(fonte, arquivo, total, casados, pendentes, criado_por)
  values (p_fonte, p_arquivo, v_total, v_casados, v_pendentes, v_email);

  return jsonb_build_object(
    'total',            v_total,
    'casados',          v_casados,
    'curso_atualizado', v_curso_upd,
    'situacao_atualizada', v_sit_upd,
    'pendentes',        v_pendentes
  );
end;
$$;

revoke all on function importar_dados_academicos(jsonb, text, text) from public;
grant execute on function importar_dados_academicos(jsonb, text, text) to authenticated;
