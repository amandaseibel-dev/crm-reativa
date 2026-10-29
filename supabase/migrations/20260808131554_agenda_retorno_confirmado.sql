-- Agenda Operacional embutida na Carteira (sugestao da operacao 2026-08-08).
--
-- O card "Agenda" na carteira lista os retornos agendados (hoje -> futuros) e
-- os atrasados. A operacao pediu poder marcar um retorno como "confirmado"
-- (ja tratado). Regras de exibicao (aplicadas no frontend):
--   * retorno de hoje ou futuro: sempre aparece;
--   * retorno atrasado (data < hoje) e NAO confirmado: aparece em vermelho por
--     ate 7 dias; depois disso sai da lista;
--   * retorno confirmado: sai da lista (tratado).
--
-- Aqui criamos o registro do "confirmado": uma coluna carimbo + RPC gated.

-- 1) Carimbo de confirmacao do retorno (idempotente).
alter table public.alunos
  add column if not exists retorno_confirmado_em timestamptz;

comment on column public.alunos.retorno_confirmado_em is
  'Quando o operador confirmou (tratou) o retorno agendado atual. Reiniciado quando um novo data_retorno e agendado.';

-- 2) Ao (re)agendar um retorno, limpar a confirmacao antiga: o novo retorno
--    nasce pendente. So dispara quando data_retorno realmente muda.
create or replace function public.tg_aluno_reset_retorno_confirmado()
 returns trigger
 language plpgsql
as $function$
begin
  new.retorno_confirmado_em := null;
  return new;
end $function$;

drop trigger if exists trg_aluno_reset_retorno_confirmado on public.alunos;
create trigger trg_aluno_reset_retorno_confirmado
  before update of data_retorno on public.alunos
  for each row
  when (new.data_retorno is distinct from old.data_retorno)
  execute function public.tg_aluno_reset_retorno_confirmado();

-- 3) RPC para confirmar/desconfirmar o retorno de um aluno.
--    Gate: dono atual do caso (responsavel_atual_email) OU gestao.
create or replace function public.agenda_confirmar_retorno(
  p_aluno_id uuid,
  p_confirmar boolean default true
)
 returns timestamptz
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
declare
  v_email text := auth.email();
  v_gestao text[] := array['amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br'];
  v_dono text;
  v_novo timestamptz;
begin
  select lower(responsavel_atual_email) into v_dono
    from public.alunos where id = p_aluno_id;

  if v_dono is null and not exists (select 1 from public.alunos where id = p_aluno_id) then
    raise exception 'Aluno nao encontrado';
  end if;

  if not (lower(coalesce(v_email,'')) = coalesce(v_dono,'') or lower(coalesce(v_email,'')) = any(v_gestao)) then
    raise exception 'Sem permissao para confirmar o retorno deste aluno';
  end if;

  v_novo := case when p_confirmar then now() else null end;

  update public.alunos
    set retorno_confirmado_em = v_novo
    where id = p_aluno_id;

  return v_novo;
end $function$;

revoke all on function public.agenda_confirmar_retorno(uuid, boolean) from public;
grant execute on function public.agenda_confirmar_retorno(uuid, boolean) to authenticated;
