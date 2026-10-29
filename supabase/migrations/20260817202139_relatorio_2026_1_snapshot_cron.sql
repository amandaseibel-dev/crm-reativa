-- Relatorio 2026/1 sem negociacao -- captura AUTOMATICA do snapshot diario.
--
-- Problema: a curva de evolucao so ganhava ponto quando alguem clicava em "Atualizar"
-- na tela. Em PROD havia apenas 29/07, 30/07, 01/08, 03/08 e 17/08 -- a semana anterior
-- ficou sem historico porque ninguem abriu/clicou naqueles dias.
--
-- Correcao: (1) o gate de relatorio_mensalidades_2026_1_capturar() passa a aceitar
-- executor tecnico (service_role ou conexao sem JWT: postgres/cron/migration), padrao
-- ja usado no projeto; (2) cron diario 02:50 UTC = 23:50 BRT, ou seja, grava o
-- FECHAMENTO do dia corrente (v_dia usa now() em America/Sao_Paulo).
-- Nao altera regra do relatorio, nem numeros, nem escreve fora da tabela de snapshot.

BEGIN;

CREATE OR REPLACE FUNCTION public.relatorio_mensalidades_2026_1_capturar()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(coalesce(auth.email(),''));
  v_gestao boolean := v_email IN ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br','cobranca07@aelbra.com.br');
  -- executor tecnico: service_role (Edge) ou conexao sem JWT (postgres/cron/migration)
  v_tecnico boolean := coalesce(auth.role(),'') = 'service_role' OR auth.jwt() IS NULL;
  v_dia date := (now() at time zone 'America/Sao_Paulo')::date;
  v_cpfs int; v_alunos int; v_mens int; v_saldo numeric;
BEGIN
  IF NOT v_tecnico AND NOT v_gestao THEN
    RAISE EXCEPTION 'Acesso negado: restrito a gestao.' USING ERRCODE='42501';
  END IF;
  SELECT count(distinct cpf), count(distinct aluno_id), count(*), round(coalesce(sum(saldo),0),2)
    INTO v_cpfs, v_alunos, v_mens, v_saldo FROM public._relatorio_2026_1_eleg();
  INSERT INTO public.relatorio_mens_2026_1_snapshot (dia, cpfs, alunos, mensalidades, saldo, capturado_em, capturado_por)
  VALUES (v_dia, v_cpfs, v_alunos, v_mens, v_saldo, now(), coalesce(nullif(v_email,''),'cron'))
  ON CONFLICT (dia) DO UPDATE SET
    cpfs=excluded.cpfs, alunos=excluded.alunos, mensalidades=excluded.mensalidades,
    saldo=excluded.saldo, capturado_em=now(), capturado_por=excluded.capturado_por;
  RETURN jsonb_build_object('dia',v_dia,'cpfs',v_cpfs,'alunos',v_alunos,'mensalidades',v_mens,'saldo',v_saldo);
END;
$function$;

COMMENT ON FUNCTION public.relatorio_mensalidades_2026_1_capturar() IS
  'Grava o ponto do dia na curva do relatorio 2026/1 sem negociacao. Gestao (tela) ou executor tecnico (cron diario 23:50 BRT).';

-- Cron: 02:50 UTC = 23:50 BRT -> registra o fechamento do dia corrente (BRT).
select cron.unschedule('relatorio_2026_1_snapshot_diario')
where exists (select 1 from cron.job where jobname='relatorio_2026_1_snapshot_diario');
select cron.schedule('relatorio_2026_1_snapshot_diario', '50 2 * * *',
  $cron$ select public.relatorio_mensalidades_2026_1_capturar(); $cron$);

COMMIT;
