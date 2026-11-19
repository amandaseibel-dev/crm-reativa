-- COMPLEMENTO DE BANCADA · cadeia da liberação, com limites declarados (12/11/2026).
--
-- Carregar DEPOIS de fidelizacao_giro_prod_20261112.sql. Traz o que a bancada
-- anterior NÃO reproduzia e que decide o que a liberação faz com o aluno:
--
--   1. `casos_elegiveis_liberacao_fidelizacao` na versão de PRODUÇÃO de
--      12/11 (md5 0d5c511a…), com o congelamento de 26/10. A bancada de 30/09
--      trazia a versão antiga (fb72379b…).
--   2. Oito gatilhos de `alunos` que disparam quando o dono do caso muda:
--      casos -> trg_sync_alunos_apos_casos -> internal.set_resp_aluno, que ZERA
--      proxima_acao / data_retorno / hora_retorno do aluno; e os gatilhos que
--      devolvem acionamento e status, limpam a origem do retorno, guardam a
--      troca de responsável, propagam o dono a TODOS os casos do aluno e auditam.
--   3. `set_resp_aluno` com o DONO de produção (reativa_responsavel_executor):
--      é isso que faz o guard `_guard_resp_aluno` deixar a troca passar.
--
-- O QUE É CONFERIDO CONTRA PRODUÇÃO DE 12/11 (md5 de prosrc, no .md5.json): os
-- 10 corpos deste arquivo e mais 20 funções da cadeia que vêm das bancadas
-- anteriores e continuam idênticas em produção.
--
-- O QUE NÃO É IGUAL A PRODUÇÃO, declarado e travado por teste
-- ("fidelidade da bancada", em fidelizacao_giro_lotes.test.js):
--   * `caso_encerrado_operacional`: a bancada usa o corpo de 30/09; produção
--     delega a `_caso_encerrado_operacional_regra` (congelamento + saldo
--     conferido). Aqui o congelamento é testado direto por
--     `caso_encerramento_congelado`.
--   * `caso_aguarda_confirmacao_financeira` e `fn_atualizar_ultimo_acionamento`:
--     corpos de 30/09.
--   * 3 gatilhos de `casos` e 11 de `alunos` não reproduzidos (auditoria,
--     gatilhos disparados por STATUS e o espelho `alunos_unificados`).
--
-- DUBLÊS DE INFRAESTRUTURA (NÃO são corpo de produção, fora do md5):
--   * public.audit_log                     colunas mínimas que fn_audit_responsavel_aluno escreve
--   * public.caso_encerramento_sem_saldo   colunas mínimas que o congelamento lê (começa vazia)
--   * auth.email()                         lê o e-mail do JWT, como o Supabase
--
-- NENHUM DADO REAL.

-- ---------------------------------------------------------------- dublês
create table if not exists public.audit_log (
  id bigserial primary key,
  tabela text, operacao text, registro_id text, usuario text,
  dados_antes jsonb, dados_depois jsonb, criado_em timestamptz default now()
);

create table if not exists public.caso_encerramento_sem_saldo (
  id bigserial primary key,
  caso_id uuid not null,
  resolvido_em timestamptz
);

create or replace function auth.email() returns text language sql stable as $stub$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$stub$;

-- ------------------------------------------------- congelamento + elegíveis
CREATE OR REPLACE FUNCTION public.caso_encerramento_congelado(p_caso_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.caso_encerramento_sem_saldo e
                  where e.resolvido_em is null and e.caso_id = p_caso_id);
$function$;

CREATE OR REPLACE FUNCTION public.casos_elegiveis_liberacao_fidelizacao()
 RETURNS TABLE(caso_id uuid, aluno_id uuid, operador_email text, operador_nome text, data_ultimo_acionamento date, fidelizado_ate date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'internal'
AS $function$
  select c.id, c.aluno_id, c.operador_email, c.operador_nome,
    c.data_ultimo_acionamento,
    case when c.data_ultimo_acionamento is not null then c.data_ultimo_acionamento + 10 end as fidelizado_ate
  from public.casos c
  left join public.alunos a on a.id = c.aluno_id
  where c.operador_email is not null and lower(c.operador_email) <> internal.carteira_geral_email()
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
          c.status_financeiro, c.status_jornada)
    -- 26/10/2026: caso congelado nao e solto da carteira. Sem esta linha, a
    -- troca da regra soltaria 8 casos / R$ 7.584,60 na primeira passagem.
    and not public.caso_encerramento_congelado(c.id)
    and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento + 10 < current_date)
    and coalesce(a.responsavel_atual_em, c.caso_atualizado_em, now() - interval '2 days') < now() - interval '1 day'
  order by c.data_ultimo_acionamento asc nulls first;
$function$;

-- ----------------------------------------------- funções dos gatilhos de alunos
CREATE OR REPLACE FUNCTION public._acionamento_nao_volta_para_nulo()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Acionamento e fato consumado: uma vez registrado, nao se apaga.
  if old.data_ultimo_acionamento is not null and new.data_ultimo_acionamento is null then
    new.data_ultimo_acionamento := old.data_ultimo_acionamento;
  end if;

  -- A tabulacao do contato acompanha o acionamento.
  if old.status_acionamento is not null
     and nullif(btrim(old.status_acionamento),'') is not null
     and new.status_acionamento is null then
    new.status_acionamento := old.status_acionamento;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public._guard_resp_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.responsavel_atual_email is distinct from old.responsavel_atual_email then
    if current_user = 'reativa_responsavel_executor' then return new; end if;
    -- alinhamento automatico do dono quando a divida e so de acordo
    if coalesce(current_setting('reativa.dono_por_acordo', true), '') = '1' then return new; end if;
    -- auto-atribuicao de caso livre (regra existente)
    if old.responsavel_atual_email is null
       and lower(coalesce(new.responsavel_atual_email,'')) = lower(coalesce(auth.jwt()->>'email','')) then
      return new;
    end if;
    raise exception 'SEM_PERMISSAO_ALTERAR_RESPONSAVEL_ALUNO';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public._nome_do_operador_no_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_nome text;
begin
  if new.operador_email is not null then
    v_nome := public.nome_do_operador(new.operador_email);
    if v_nome is not null then new.operador_nome := v_nome; end if;
  end if;
  if new.responsavel_atual_email is not null then
    v_nome := public.nome_do_operador(new.responsavel_atual_email);
    if v_nome is not null then new.responsavel_atual_nome := v_nome; end if;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public._sync_casos_resp_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.responsavel_atual_email is distinct from old.responsavel_atual_email then
    update public.casos
       set operador_email = lower(new.responsavel_atual_email),
           operador_nome  = new.responsavel_atual_nome,
           operador       = new.responsavel_atual_nome,
           caso_atualizado_por = coalesce(new.registrado_por_email, lower(coalesce(auth.jwt() ->> 'email',''))),
           caso_atualizado_em  = now()
     where aluno_id = new.id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_audit_responsavel_aluno()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_user text := coalesce(nullif(lower(auth.email()),''), 'Sistema (rotina interna)');
begin
  if NEW.responsavel_atual_email IS NOT DISTINCT FROM OLD.responsavel_atual_email then
    return NEW;
  end if;

  insert into public.audit_log (tabela, operacao, registro_id, usuario, dados_antes, dados_depois)
  values (
    'alunos.responsavel', 'TROCA_RESPONSAVEL', NEW.id::text, v_user,
    jsonb_build_object('responsavel_email', OLD.responsavel_atual_email,
                       'responsavel_nome',  OLD.responsavel_atual_nome),
    jsonb_build_object('responsavel_email', NEW.responsavel_atual_email,
                       'responsavel_nome',  NEW.responsavel_atual_nome)
  );
  return NEW;
end $function$;

CREATE OR REPLACE FUNCTION public.fn_sync_acionamento_alunos_para_casos()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_dia date;
begin
  if new.data_ultimo_acionamento is not null
     and new.data_ultimo_acionamento is distinct from old.data_ultimo_acionamento then
    v_dia := (new.data_ultimo_acionamento at time zone 'America/Sao_Paulo')::date;
    update public.casos c
       set data_ultimo_acionamento = v_dia
     where c.aluno_id = new.id
       and (c.data_ultimo_acionamento is null or c.data_ultimo_acionamento < v_dia);
  end if;
  return new;
end; $function$;

CREATE OR REPLACE FUNCTION public.limpar_retorno_origem()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.data_retorno is null then
    new.retorno_origem := null;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.tg_aluno_reset_retorno_confirmado()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.retorno_confirmado_em := null;
  return new;
end $function$;

-- ------------------------------------------------------ gatilhos (defs de PROD)
CREATE TRIGGER trg_acionamento_nao_volta_para_nulo BEFORE UPDATE OF data_ultimo_acionamento, status_acionamento ON public.alunos FOR EACH ROW EXECUTE FUNCTION _acionamento_nao_volta_para_nulo();
CREATE TRIGGER trg_aluno_reset_retorno_confirmado BEFORE UPDATE OF data_retorno ON public.alunos FOR EACH ROW WHEN ((new.data_retorno IS DISTINCT FROM old.data_retorno)) EXECUTE FUNCTION tg_aluno_reset_retorno_confirmado();
CREATE TRIGGER trg_alunos_retorno_origem BEFORE INSERT OR UPDATE OF data_retorno, retorno_origem ON public.alunos FOR EACH ROW EXECUTE FUNCTION limpar_retorno_origem();
CREATE TRIGGER trg_audit_responsavel_aluno AFTER UPDATE OF responsavel_atual_email ON public.alunos FOR EACH ROW EXECUTE FUNCTION fn_audit_responsavel_aluno();
CREATE TRIGGER trg_guard_resp_aluno BEFORE UPDATE ON public.alunos FOR EACH ROW EXECUTE FUNCTION _guard_resp_aluno();
CREATE TRIGGER trg_nome_do_operador_no_aluno BEFORE INSERT OR UPDATE OF operador_email, operador_nome, responsavel_atual_email, responsavel_atual_nome ON public.alunos FOR EACH ROW EXECUTE FUNCTION _nome_do_operador_no_aluno();
CREATE TRIGGER trg_sync_acionamento_alunos_para_casos AFTER UPDATE OF data_ultimo_acionamento ON public.alunos FOR EACH ROW EXECUTE FUNCTION fn_sync_acionamento_alunos_para_casos();
CREATE TRIGGER trg_sync_casos_resp_aluno AFTER UPDATE OF responsavel_atual_email ON public.alunos FOR EACH ROW EXECUTE FUNCTION _sync_casos_resp_aluno();

-- --------------------------- DONO DE PRODUCAO de internal.set_resp_aluno
-- Em producao o dono e `reativa_responsavel_executor` (e e por isso que o guard
-- acima deixa a troca passar). Sem trocar o dono, a bancada exercitaria um
-- caminho que nao existe em producao.
do $dono$
begin
  if not exists (select 1 from pg_roles where rolname = 'reativa_responsavel_executor') then
    create role reativa_responsavel_executor nologin;
  end if;
end
$dono$;
grant usage on schema public, internal to reativa_responsavel_executor;
grant select, insert, update on all tables in schema public to reativa_responsavel_executor;
grant usage, select on all sequences in schema public to reativa_responsavel_executor;
alter function internal.set_resp_aluno(uuid, text, text, text, text, text, text) owner to reativa_responsavel_executor;
