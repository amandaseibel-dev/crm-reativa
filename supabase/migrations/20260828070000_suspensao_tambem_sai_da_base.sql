-- Suspensao de cobranca tambem encerra a operacao (decisao da Amanda, 28/08).
-- 1) o gatilho de encerramento passa a reconhecer suspensao
create or replace function public.caso_encerrado_operacional(
  p_cpf text, p_status_atual text, p_status_acionamento text,
  p_status_financeiro text, p_status_jornada text)
returns boolean
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  bloq text[] := array['CANCELADO','CANCELAMENTO COBRANCA','JURIDICO',
                       'SUSPENSAO COBRANCA','SUSPENSAO DE COBRANCA'];
  quit text[] := array['PAGO','QUITADO','QUITACAO','QUITADO MANUAL','QUITADO AUTOMATICO','SEM SALDO EM ABERTO'];
  nat text := public.normalizar_status_acionamento(p_status_atual);
  nac text := public.normalizar_status_acionamento(p_status_acionamento);
  nfi text := public.normalizar_status_acionamento(p_status_financeiro);
  njo text := public.normalizar_status_acionamento(p_status_jornada);
begin
  if nat = any(bloq) or nac = any(bloq) or nfi = any(bloq) or njo = any(bloq) then return true; end if;
  if nat = 'SEM SALDO EM ABERTO' or nac = 'SEM SALDO EM ABERTO' or njo = 'SEM SALDO EM ABERTO' then return true; end if;
  if nat = 'SALDO ZERO CONFIRMADO' or nac = 'SALDO ZERO CONFIRMADO' or nfi = 'SALDO ZERO CONFIRMADO' or njo = 'SALDO ZERO CONFIRMADO' then return true; end if;
  if (nat = any(quit) or nac = any(quit) or nfi = any(quit) or njo = any(quit)) and public.saldo_titulos_aberto(p_cpf) = 0 then return true; end if;
  return false;
end;
$function$;

-- 2) a propagacao aluno -> caso passa a cobrir suspensao
create or replace function public.alunos_propaga_encerramento_para_caso()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if upper(coalesce(new.status_atual,'')) is distinct from upper(coalesce(old.status_atual,''))
     and upper(coalesce(new.status_atual,'')) in ('JURIDICO','CANCELAMENTO_COBRANCA','SUSPENSAO_COBRANCA') then
    update public.casos
       set status_atual = case upper(new.status_atual)
                            when 'JURIDICO' then 'JURIDICO'
                            when 'SUSPENSAO_COBRANCA' then 'SUSPENSAO COBRANCA'
                            else 'CANCELAMENTO COBRANCA' end
     where aluno_id = new.id
       and not coalesce(encerrado_operacional, false);
  end if;
  return new;
end;
$$;

-- 3) backup e backfill dos que ja estao marcados
create table if not exists public._backup_suspensao_sai_da_base_20260828 as
select c.id as caso_id, c.aluno_id, c.nome, c.status_atual as caso_status_antes,
       c.encerrado_operacional as encerrado_antes, al.responsavel_atual_email,
       c.saldo_total, now() as ajustado_em
from public.casos c
join public.alunos al on al.id = c.aluno_id
where upper(coalesce(al.status_atual,'')) = 'SUSPENSAO_COBRANCA'
  and not coalesce(c.encerrado_operacional, false);

update public.casos c
   set status_atual = 'SUSPENSAO COBRANCA'
  from public.alunos al
 where al.id = c.aluno_id
   and upper(coalesce(al.status_atual,'')) = 'SUSPENSAO_COBRANCA'
   and not coalesce(c.encerrado_operacional, false);
