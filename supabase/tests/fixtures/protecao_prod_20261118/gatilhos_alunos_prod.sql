set check_function_bodies = off;

-- public._acionamento_nao_volta_para_nulo()
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

-- public.limpar_retorno_origem()
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

-- public.tg_aluno_reset_retorno_confirmado()
CREATE OR REPLACE FUNCTION public.tg_aluno_reset_retorno_confirmado()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.retorno_confirmado_em := null;
  return new;
end $function$;
set check_function_bodies = on;

drop trigger if exists trg_acionamento_nao_volta_para_nulo on public.alunos;
CREATE TRIGGER trg_acionamento_nao_volta_para_nulo BEFORE UPDATE OF data_ultimo_acionamento, status_acionamento ON public.alunos FOR EACH ROW EXECUTE FUNCTION _acionamento_nao_volta_para_nulo();
drop trigger if exists trg_alunos_retorno_origem on public.alunos;
CREATE TRIGGER trg_alunos_retorno_origem BEFORE INSERT OR UPDATE OF data_retorno, retorno_origem ON public.alunos FOR EACH ROW EXECUTE FUNCTION limpar_retorno_origem();
drop trigger if exists trg_aluno_reset_retorno_confirmado on public.alunos;
CREATE TRIGGER trg_aluno_reset_retorno_confirmado BEFORE UPDATE OF data_retorno ON public.alunos FOR EACH ROW WHEN ((new.data_retorno IS DISTINCT FROM old.data_retorno)) EXECUTE FUNCTION tg_aluno_reset_retorno_confirmado();
