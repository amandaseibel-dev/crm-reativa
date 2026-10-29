-- ============================================================================
-- Sincronizar data_ultimo_acionamento: alunos (fonte real) -> casos.
--
-- Causa raiz: várias RPCs de acionamento (links de pagamento, retorno de termo,
-- comprovante para baixa, ações massivas) atualizam apenas
-- alunos.data_ultimo_acionamento, deixando casos.data_ultimo_acionamento
-- defasado. Base inteira: ~73% dos casos com dono estavam atrasados; o painel
-- do operador lê `alunos` (correto), mas telas/rotinas que leem `casos`
-- (Calibragem, fidelização 10 dias, teto de operadores) ficavam erradas.
--
-- OBS de tipos: alunos.data_ultimo_acionamento é timestamptz; casos é date.
-- A conversão usa o fuso America/Sao_Paulo (Brasília).
--
-- 1) PASSADO — backfill: casos avança para o dia real de alunos (só p/ frente,
--    nunca regride -> seguro para a fidelização, que só estenderia retenção).
-- 2) FUTURO — trigger em alunos que propaga para casos automaticamente,
--    cobrindo TODAS as RPCs de acionamento (atuais e futuras) num único objeto.
-- ============================================================================

-- 1) Backfill (passado)
update public.casos c
   set data_ultimo_acionamento = (al.data_ultimo_acionamento at time zone 'America/Sao_Paulo')::date
  from public.alunos al
 where al.id = c.aluno_id
   and al.data_ultimo_acionamento is not null
   and (c.data_ultimo_acionamento is null
        or (al.data_ultimo_acionamento at time zone 'America/Sao_Paulo')::date > c.data_ultimo_acionamento);

-- 2) Trigger (futuro)
create or replace function public.fn_sync_acionamento_alunos_para_casos()
returns trigger language plpgsql security definer set search_path to 'public' as $$
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
end; $$;

drop trigger if exists trg_sync_acionamento_alunos_para_casos on public.alunos;
create trigger trg_sync_acionamento_alunos_para_casos
  after update of data_ultimo_acionamento on public.alunos
  for each row
  execute function public.fn_sync_acionamento_alunos_para_casos();
