-- MUTIRÃO TEMPORÁRIO para fechar os 2.853 CPFs da faixa "sem negociação 2026".
--
-- A rotina normal faz 300 por noite -- a faixa levaria 10 dias. A pedido da
-- Amanda, acelera para 150 a cada 15 minutos (600/hora), fechando em ~5h.
--
-- POR QUE 150 E NÃO 300: o lote de 60 levou ~2 min e voltou com 3 erros em 60
-- (5%, provavelmente 503 da Prime). Lote menor = menos coisa perdida quando a
-- Prime engasga. E quem falha volta para a fila sozinho, porque só sai dela
-- quem teve contrato gravado.
--
-- A VOLTA É AGENDADA JUNTO. Às 10h UTC (07h BRT) o mutirão se desliga e o
-- diário volta às 03h10. Sem isso alguém teria que lembrar de desfazer -- e
-- ninguém lembra. O job de volta se apaga também, então não sobra lixo no cron.
--
-- APLICADA EM PROD em 2026-08-25.

create or replace function public.prime_cadastro_encerrar_mutirao()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  PERFORM cron.unschedule('prime_cadastro_mutirao')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prime_cadastro_mutirao');

  PERFORM cron.unschedule('prime_cadastro_noturno')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prime_cadastro_noturno');

  PERFORM cron.schedule(
    'prime_cadastro_noturno',
    '10 6 * * *',
    $sql$ select public.prime_cadastro_disparar_noturno(300); $sql$
  );

  INSERT INTO public.prime_cadastro_execucoes (origem, observacao)
  VALUES ('cron', 'mutirao encerrado; rotina diaria restaurada as 03h10 BRT');

  PERFORM cron.unschedule('prime_cadastro_fim_mutirao')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prime_cadastro_fim_mutirao');
END;
$function$;

revoke all on function public.prime_cadastro_encerrar_mutirao() from public, authenticated;
grant execute on function public.prime_cadastro_encerrar_mutirao() to service_role;

select cron.unschedule('prime_cadastro_noturno')
 where exists (select 1 from cron.job where jobname = 'prime_cadastro_noturno');

select cron.schedule('prime_cadastro_mutirao', '*/15 * * * *',
  $cron$ select public.prime_cadastro_disparar_noturno(150); $cron$);

select cron.schedule('prime_cadastro_fim_mutirao', '0 10 * * *',
  $cron$ select public.prime_cadastro_encerrar_mutirao(); $cron$);
