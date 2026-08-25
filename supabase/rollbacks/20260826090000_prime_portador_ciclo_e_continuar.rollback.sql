-- Rollback da varredura de portador.
--
-- A coluna `ciclo` NAO e removida: ela e barata e a lista ja coletada depende
-- dela para saber de que rodada veio. Remover a coluna transformaria a lista
-- num monte de CPFs sem procedencia.

select cron.unschedule('prime_portador_195')
where exists (select 1 from cron.job where jobname = 'prime_portador_195');

drop function if exists public.prime_portador_continuar(integer);
