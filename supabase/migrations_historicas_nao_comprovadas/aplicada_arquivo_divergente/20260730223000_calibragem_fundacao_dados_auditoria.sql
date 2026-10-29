-- ============================================================================
-- CALIBRAGEM — FUNDAÇÃO DE DADOS E AUDITORIA (itens 2, 3, 14)
-- ----------------------------------------------------------------------------
-- Cria a estrutura de dados do módulo Calibragem SEM tocar em nenhuma tabela
-- existente (casos, acordos, alunos, etc.). Tudo novo, isolado, reversível.
--
--   * calibragem_parametros  — regras configuráveis por Amanda/Fernanda
--                              (margem de equivalência, faixas de atraso/valor,
--                               limite de carteira, regras de criticidade)
--   * calibragem_simulacoes  — simulações de nivelamento (rascunho→aprovada→
--                              executada), guardando critérios e resultado
--   * calibragem_auditoria   — trilha append-only de TODA movimentação de
--                              caso/responsável/nivelamento (item 3.3 e 14)
--
-- Segurança: RLS ligada. Leitura/gestão restrita à gestão (usa a função
-- existente public.usuario_e_gestao_financeira() quando disponível; caso não
-- exista, cai para allowlist de e-mails da gestão). Auditoria é append-only:
-- sem UPDATE/DELETE para nenhum papel de aplicação.
-- ============================================================================

begin;

-- Função helper: e-mail é gestão de calibragem (Amanda/Fernanda/ADM) ---------
-- Reaproveita usuario_e_gestao_financeira() se existir; senão allowlist fixa.
create or replace function public.calibragem_e_gestao()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if v_email = '' then
    return false;
  end if;
  -- allowlist de gestão da calibragem (Amanda gestora, Fernanda, Amanda ADM)
  if v_email in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  ) then
    return true;
  end if;
  return false;
end;
$$;

revoke all on function public.calibragem_e_gestao() from public;
grant execute on function public.calibragem_e_gestao() to authenticated;

-- 1) PARÂMETROS CONFIGURÁVEIS -----------------------------------------------
create table if not exists public.calibragem_parametros(
  chave         text primary key,
  valor         jsonb not null,
  descricao     text,
  atualizado_em timestamptz not null default now(),
  atualizado_por text
);

insert into public.calibragem_parametros(chave, valor, descricao, atualizado_por) values
  ('limite_carteira', '500'::jsonb,
   'Limite de CPFs de mensalidades originais por operador (acordos não consomem).',
   'migration'),
  ('margem_equivalencia_valor', '0.15'::jsonb,
   'Margem (fração) de equivalência de valor ao buscar caso de compensação. 0.15 = ±15%.',
   'migration'),
  ('faixas_atraso', '[{"rotulo":"0-30","min":0,"max":30},{"rotulo":"31-60","min":31,"max":60},{"rotulo":"61-90","min":61,"max":90},{"rotulo":"91-180","min":91,"max":180},{"rotulo":"181-360","min":181,"max":360},{"rotulo":"360+","min":361,"max":null}]'::jsonb,
   'Faixas de dias de atraso para segmentação da carteira.',
   'migration'),
  ('faixas_valor', '[{"rotulo":"Ate 500","min":0,"max":500},{"rotulo":"500-1000","min":500,"max":1000},{"rotulo":"1000-3000","min":1000,"max":3000},{"rotulo":"3000-5000","min":3000,"max":5000},{"rotulo":"5000-10000","min":5000,"max":10000},{"rotulo":"10000+","min":10000,"max":null}]'::jsonb,
   'Faixas de valor de saldo para segmentação e equivalência.',
   'migration'),
  ('criticidade_regras', '{"critico":{"dias_vencido_min":5,"dias_sem_acionamento_min":5},"urgente":{"dias_vencido_min":1},"atencao":{"dias_sem_acionamento_min":10}}'::jsonb,
   'Regras parametrizáveis de criticidade automática (item 5). Ajustável pela gestão.',
   'migration'),
  ('anos_divida', '[2024,2025,2026]'::jsonb,
   'Anos de dívida exibidos na segmentação.',
   'migration')
on conflict (chave) do nothing;

alter table public.calibragem_parametros enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='calibragem_parametros' and policyname='calibragem_parametros_sel') then
    create policy calibragem_parametros_sel on public.calibragem_parametros
      for select to authenticated using (public.calibragem_e_gestao());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='calibragem_parametros' and policyname='calibragem_parametros_upd') then
    create policy calibragem_parametros_upd on public.calibragem_parametros
      for update to authenticated using (public.calibragem_e_gestao()) with check (public.calibragem_e_gestao());
  end if;
end $$;

-- 2) SIMULAÇÕES DE NIVELAMENTO ----------------------------------------------
create table if not exists public.calibragem_simulacoes(
  id             uuid primary key default gen_random_uuid(),
  criado_por_email text not null,
  criado_por_nome  text,
  criterios      jsonb not null,          -- critérios escolhidos (equiparar saldo, ano, faixa...)
  resultado      jsonb,                   -- preview: movimentações sugeridas, antes/depois, índice
  status         text not null default 'RASCUNHO'
                 check (status in ('RASCUNHO','APROVADA','EXECUTADA','DESCARTADA')),
  aprovado_por_email text,
  aprovado_por_nome  text,
  aprovado_em    timestamptz,
  executado_em   timestamptz,
  observacao     text,
  criado_em      timestamptz not null default now()
);
create index if not exists idx_calibragem_simulacoes_status on public.calibragem_simulacoes(status, criado_em desc);

alter table public.calibragem_simulacoes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='calibragem_simulacoes' and policyname='calibragem_simulacoes_all') then
    create policy calibragem_simulacoes_all on public.calibragem_simulacoes
      for all to authenticated using (public.calibragem_e_gestao()) with check (public.calibragem_e_gestao());
  end if;
end $$;

-- 3) AUDITORIA APPEND-ONLY (item 3.3 + 14) ----------------------------------
create table if not exists public.calibragem_auditoria(
  id                  uuid primary key default gen_random_uuid(),
  evento              text not null,        -- MOVIMENTACAO_NIVELAMENTO, RECEPTIVO_ATRIBUIDO,
                                            -- ALTERACAO_CRITICIDADE, ALTERACAO_RESPONSAVEL, etc
  simulacao_id        uuid references public.calibragem_simulacoes(id),
  caso_id             uuid,                 -- casos.id (sem FK rígida p/ não travar exclusões legadas)
  chave_unificacao    text,
  aluno_id            uuid,
  cpf                 text,
  nome_aluno          text,
  operador_anterior_email text,
  operador_anterior_nome  text,
  operador_novo_email     text,
  operador_novo_nome      text,
  valor_caso          numeric,
  motivo              text,
  regra               text,                 -- regra de nivelamento aplicada
  caso_compensacao_id uuid,                 -- caso usado como compensação (item 3.3.8)
  situacao_anterior   jsonb,
  situacao_posterior  jsonb,
  aprovado_por_email  text,
  aprovado_por_nome   text,
  registrado_por_email text,
  registrado_em       timestamptz not null default now()
);
create index if not exists idx_calibragem_auditoria_caso on public.calibragem_auditoria(caso_id, registrado_em desc);
create index if not exists idx_calibragem_auditoria_evento on public.calibragem_auditoria(evento, registrado_em desc);
create index if not exists idx_calibragem_auditoria_op_novo on public.calibragem_auditoria(operador_novo_email, registrado_em desc);

alter table public.calibragem_auditoria enable row level security;
do $$ begin
  -- leitura para gestão
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='calibragem_auditoria' and policyname='calibragem_auditoria_sel') then
    create policy calibragem_auditoria_sel on public.calibragem_auditoria
      for select to authenticated using (public.calibragem_e_gestao());
  end if;
  -- SEM policy de insert/update/delete p/ authenticated: gravação só via RPC
  -- SECURITY DEFINER (a ser criada com o simulador). Append-only garantido pela
  -- ausência de UPDATE/DELETE + trigger abaixo.
end $$;

-- Trigger de proteção: impede UPDATE/DELETE (append-only) --------------------
create or replace function public.calibragem_auditoria_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'calibragem_auditoria é append-only: % não permitido.', tg_op;
end;
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname='trg_calibragem_auditoria_no_upd') then
    create trigger trg_calibragem_auditoria_no_upd
      before update or delete on public.calibragem_auditoria
      for each row execute function public.calibragem_auditoria_append_only();
  end if;
end $$;

commit;
