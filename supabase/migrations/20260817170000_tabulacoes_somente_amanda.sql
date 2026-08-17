-- Catálogo de tabulações: restringir a edição SÓ à Amanda.
--
-- DECISÃO (Amanda, 2026-08-17): quem inclui, edita ou tira tabulação da lista é
-- só ela. A versão anterior (20260817160000) usava public.usuario_e_gestao(),
-- que também libera Fernanda (cobranca04) e Amanda ADM (cobranca07).
--
-- POR QUE UM PORTÃO NOVO EM VEZ DE MEXER EM usuario_e_gestao():
-- aquela função é compartilhada por Calibragem, snapshot gerencial e várias
-- outras RPCs. Estreitá-la pra um e-mail só tiraria a Fernanda e a Amanda ADM
-- de tudo o mais que elas usam hoje. O portão daqui é dedicado ao catálogo.
--
-- Mesmo critério dos outros dois portões "só Amanda" que já existiam:
-- Borderôs/Importações (app_pode_borderos_importacoes) e baixa de pagamento --
-- ambos usam apenas o e-mail corporativo amanda.seibel@aelbra.com.br.
--
-- LEITURA NÃO MUDA: qualquer usuário autenticado continua lendo o catálogo (a
-- equipe inteira precisa dele pra montar a lista de tabular). O que fica
-- restrito é a ESCRITA.
--
-- A regra central segue idêntica: editar o catálogo NÃO reescreve agendamento
-- já existente -- só vale a partir da próxima tabulação do aluno.

create or replace function public.usuario_pode_editar_tabulacoes()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select lower(coalesce(auth.jwt()->>'email','')) = 'amanda.seibel@aelbra.com.br';
$function$;

comment on function public.usuario_pode_editar_tabulacoes() is
  'Portão de escrita do catálogo de tabulações. Só a Amanda. Deliberadamente mais restrito que usuario_e_gestao() -- não trocar por ela.';

revoke all on function public.usuario_pode_editar_tabulacoes() from public, anon;
grant execute on function public.usuario_pode_editar_tabulacoes() to authenticated;

-- ---------------------------------------------------------------------------
-- Troca o portão nas três RPCs de escrita. Só a linha do `if not ...` muda.
-- ---------------------------------------------------------------------------
create or replace function public.tabulacao_salvar(
  p_codigo               text,
  p_rotulo               text,
  p_grupo                text default 'CONTATO',
  p_retorno_modo         text default 'NENHUM',
  p_retorno_dias_uteis   integer default null,
  p_proxima_acao         text default 'CONTATAR',
  p_bloco_ficha          text default null,
  p_exige_processo       boolean default false,
  p_bloqueia_acionamento boolean default false,
  p_ordem                integer default null
)
returns public.tabulacoes
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cod   text := upper(btrim(coalesce(p_codigo,'')));
  v_rot   text := btrim(coalesce(p_rotulo,''));
  v_dias  integer := case when p_retorno_modo = 'DIAS_UTEIS' then p_retorno_dias_uteis else null end;
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_ordem integer;
  v_row   public.tabulacoes;
begin
  if not public.usuario_pode_editar_tabulacoes() then
    raise exception 'Sem permissao: so a Amanda pode incluir ou editar tabulacoes.'
      using errcode = '42501';
  end if;
  if v_cod = '' then
    raise exception 'Informe o codigo da tabulacao.' using errcode = '22023';
  end if;
  if v_rot = '' then
    raise exception 'Informe o rotulo da tabulacao.' using errcode = '22023';
  end if;

  v_ordem := coalesce(
    p_ordem,
    (select coalesce(max(ordem),0) + 10 from public.tabulacoes where grupo = p_grupo),
    500
  );

  insert into public.tabulacoes as t
    (codigo, rotulo, grupo, retorno_modo, retorno_dias_uteis, proxima_acao,
     bloco_ficha, exige_processo, bloqueia_acionamento, ordem, ativa, criado_por)
  values
    (v_cod, v_rot, p_grupo, p_retorno_modo, v_dias, p_proxima_acao,
     nullif(btrim(coalesce(p_bloco_ficha,'')),''), p_exige_processo,
     p_bloqueia_acionamento, v_ordem, true, v_email)
  on conflict (codigo) do update set
     rotulo               = excluded.rotulo,
     grupo                = excluded.grupo,
     retorno_modo         = excluded.retorno_modo,
     retorno_dias_uteis   = excluded.retorno_dias_uteis,
     proxima_acao         = excluded.proxima_acao,
     bloco_ficha          = excluded.bloco_ficha,
     exige_processo       = excluded.exige_processo,
     bloqueia_acionamento = excluded.bloqueia_acionamento,
     ordem                = excluded.ordem,
     atualizado_em        = now(),
     atualizado_por       = v_email
  returning t.* into v_row;

  return v_row;
end;
$function$;

create or replace function public.tabulacao_desativar(p_codigo text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cod   text := upper(btrim(coalesce(p_codigo,'')));
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_ativas integer;
begin
  if not public.usuario_pode_editar_tabulacoes() then
    raise exception 'Sem permissao: so a Amanda pode desativar tabulacoes.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from public.tabulacoes where codigo = v_cod) then
    raise exception 'Tabulacao % nao existe.', v_cod using errcode = '02000';
  end if;

  select count(*) into v_ativas from public.tabulacoes where ativa and codigo <> v_cod;
  if v_ativas = 0 then
    raise exception 'Nao da pra desativar a ultima tabulacao ativa.' using errcode = '23514';
  end if;

  update public.tabulacoes
     set ativa = false, desativada_em = now(), desativada_por = v_email
   where codigo = v_cod;

  return public.tabulacao_impacto(v_cod) || jsonb_build_object('ativa', false);
end;
$function$;

create or replace function public.tabulacao_reativar(p_codigo text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cod   text := upper(btrim(coalesce(p_codigo,'')));
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
begin
  if not public.usuario_pode_editar_tabulacoes() then
    raise exception 'Sem permissao: so a Amanda pode reativar tabulacoes.'
      using errcode = '42501';
  end if;

  update public.tabulacoes
     set ativa = true, desativada_em = null, desativada_por = null,
         atualizado_em = now(), atualizado_por = v_email
   where codigo = v_cod;

  if not found then
    raise exception 'Tabulacao % nao existe.', v_cod using errcode = '02000';
  end if;

  return public.tabulacao_impacto(v_cod) || jsonb_build_object('ativa', true);
end;
$function$;

revoke all on function public.tabulacao_salvar(text,text,text,text,integer,text,text,boolean,boolean,integer) from public, anon;
revoke all on function public.tabulacao_desativar(text) from public, anon;
revoke all on function public.tabulacao_reativar(text) from public, anon;
grant execute on function public.tabulacao_salvar(text,text,text,text,integer,text,text,boolean,boolean,integer) to authenticated;
grant execute on function public.tabulacao_desativar(text) to authenticated;
grant execute on function public.tabulacao_reativar(text) to authenticated;
