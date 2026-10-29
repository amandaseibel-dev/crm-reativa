-- Guarda quem o Prime nao devolve -- senao a fila trava neles para sempre.
--
-- O DEFEITO. A Edge Function `prime-cadastro` procura o CPF nos dois portadores
-- (195 mensalidades, 166 acordos). Quando nao acha, devolve `foraDoEscopo` e
-- NAO GRAVA NADA -- nem em prime_contratos, nem em lugar algum. A fila de
-- pendentes, por sua vez, define "falta coletar" como "nao tem linha em
-- prime_contratos". Logo, essa pessoa continua pendente para sempre.
--
-- Isso ficaria escondido enquanto sobrasse gente coletavel. Mas a ordem da fila
-- e DETERMINISTICA: os mesmos 60 CPFs voltam na mesma ordem. Quando o topo da
-- fila fosse so gente que o Prime nao conhece, a coleta pararia de vez -- 200 na
-- resposta, `aplicados: 0`, e ninguem mais coletado. Medido em 31/08 as 10:13:
-- 120 pedidos, 88 pessoas gravadas, 32 sem retorno nenhum -- 27% do lote.
--
-- A CORRECAO. A tentativa passa a ser registrada. Quem o Prime nao devolve sai
-- da fila por 7 dias -- a mesma janela de quem foi coletado com sucesso -- e
-- depois volta para nova tentativa, porque o cadastro pode aparecer no Prime
-- mais tarde. Se a coleta der certo, a marca e apagada no mesmo movimento.
--
-- De quebra a tabela responde uma pergunta que hoje nao tem resposta: de quantas
-- pessoas da nossa base o Prime nao sabe nada, e desde quando.
--
-- DESFAZER: supabase/rollbacks/20260831080000_prime_registra_quem_o_prime_nao_conhece.rollback.sql

create table if not exists public.prime_cadastro_sem_retorno (
  cpf                text primary key,
  motivo             text not null,
  tentativas         integer not null default 1,
  primeira_tentativa timestamptz not null default now(),
  ultima_tentativa   timestamptz not null default now()
);

comment on table public.prime_cadastro_sem_retorno is
  'CPFs que a coleta pediu ao Prime e o Prime nao devolveu. Sem isto a fila de pendentes volta neles a cada 2 minutos e trava.';

alter table public.prime_cadastro_sem_retorno enable row level security;

-- Ninguem le pela tela a nao ser a gestao; quem escreve e a Edge Function,
-- que usa service_role e nao passa por RLS.
drop policy if exists prime_sem_retorno_gestao_le on public.prime_cadastro_sem_retorno;
create policy prime_sem_retorno_gestao_le
  on public.prime_cadastro_sem_retorno for select
  to authenticated using (public.usuario_e_gestao());

create index if not exists ix_prime_sem_retorno_ultima
  on public.prime_cadastro_sem_retorno (ultima_tentativa desc);

-- A Edge Function chama isto uma vez por lote: apaga a marca de quem coletou
-- com sucesso e carimba quem o Prime nao devolveu.
create or replace function public.prime_cadastro_registrar_tentativa(
  p_sem_retorno text[] default '{}',
  p_ok          text[] default '{}',
  p_motivo      text   default 'FORA_DO_ESCOPO'
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_marcados integer := 0;
begin
  -- coletou: a marca antiga nao vale mais
  if p_ok is not null and array_length(p_ok, 1) > 0 then
    delete from public.prime_cadastro_sem_retorno where cpf = any(p_ok);
  end if;

  if p_sem_retorno is not null and array_length(p_sem_retorno, 1) > 0 then
    insert into public.prime_cadastro_sem_retorno (cpf, motivo)
    select distinct c, coalesce(nullif(btrim(p_motivo),''), 'FORA_DO_ESCOPO')
      from unnest(p_sem_retorno) c
     where length(regexp_replace(coalesce(c,''), '\D', '', 'g')) = 11
    on conflict (cpf) do update
      set tentativas       = public.prime_cadastro_sem_retorno.tentativas + 1,
          ultima_tentativa = now(),
          motivo           = excluded.motivo;
    get diagnostics v_marcados = row_count;
  end if;

  return v_marcados;
end;
$function$;

revoke all on function public.prime_cadastro_registrar_tentativa(text[], text[], text) from public, anon, authenticated;
grant execute on function public.prime_cadastro_registrar_tentativa(text[], text[], text) to service_role;
