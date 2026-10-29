-- Coleta Prime: de 43 noites para uma ou duas.
--
-- MEDIDO em 25/08/2026 (a Edge passou a reportar a propria duracao):
--    60 alunos, concorrencia 12 -> 67 segundos, 200 OK, 1.037 titulos
--   150 alunos, concorrencia 12 -> 504 IDLE_TIMEOUT (teto de 150s da Edge)
--   150 alunos, concorrencia  4 -> 504 IDLE_TIMEOUT (duas vezes, na madrugada
--                                  de 25/08: o "mutirao" daquele dia nao
--                                  coletou nada e ninguem soube)
--
-- Da ~1,1s por aluno. O gargalo NAO e a Ulbra (liberaram o acesso sem impor
-- teto) nem o paralelismo nosso -- e o tempo de resposta de cada chamada deles.
-- Por isso a saida nao e lote maior: e lote PEQUENO e FREQUENTE.
--
-- 60 alunos a cada 2 minutos: cada disparo termina em 67s, com folga antes do
-- proximo, sem sobreposicao. Na janela de madrugada (23h-06h BRT) sao ~210
-- disparos, ~10 mil alunos por noite. Os 12.847 pendentes saem em uma a duas
-- noites.
--
-- FREIOS: sistema_sob_carga() cancela o disparo se o CRM estiver sofrendo; a
-- Edge recua sozinha no 503 da Prime; e o envelope abaixo nao bate na API
-- quando nao ha ninguem pendente -- e o que faz esta janela larga parar sozinha
-- quando o mutirao acabar. Como a fila reabre quem foi coletado ha mais de 7
-- dias, a base se mantem atualizada depois disso.

create or replace function public.prime_cadastro_mutirao(p_limite integer default 60)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_pendentes integer;
begin
  -- So olha se existe trabalho; a RPC de pendentes ja aplica a regra de
  -- prioridade (relatorio 2026/1 sem negociacao primeiro, depois maior saldo).
  select count(*) into v_pendentes from public.prime_cadastro_pendentes(1);

  if coalesce(v_pendentes, 0) = 0 then
    insert into public.prime_cadastro_execucoes (origem, observacao)
    values ('cron', 'nao disparou: nada pendente para coletar');
    return null;
  end if;

  return public.prime_cadastro_disparar_noturno(p_limite);
end;
$$;

revoke all on function public.prime_cadastro_mutirao(integer) from public, anon, authenticated;

comment on function public.prime_cadastro_mutirao(integer) is
  'Dispara a coleta Prime apenas quando ha aluno pendente. Envelope de prime_cadastro_disparar_noturno, que ja respeita sistema_sob_carga().';

select cron.unschedule('prime_cadastro_noturno')
where exists (select 1 from cron.job where jobname = 'prime_cadastro_noturno');

select cron.unschedule('prime_cadastro_mutirao')
where exists (select 1 from cron.job where jobname = 'prime_cadastro_mutirao');

select cron.schedule(
  'prime_cadastro_mutirao',
  '*/2 2-9 * * *',
  $cron$ select public.prime_cadastro_mutirao(60); $cron$
);
