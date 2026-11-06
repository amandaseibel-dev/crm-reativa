-- CORREÇÃO RETROATIVA: CANCELADA -> DEVOLVIDO
--
-- PREPARADO EM 09/10/2026. NÃO EXECUTADO. Depende de autorização explícita da
-- gestão. Nenhuma linha deste arquivo roda sozinha: o passo que escreve está
-- comentado no fim, de propósito.
--
-- ============================================================================
-- POR QUE POR CRITÉRIO, E NÃO POR UMA LISTA DE IDs
-- ============================================================================
-- A base MUDA enquanto se mede. Em 09/10/2026 o conjunto saiu de 52 para 59
-- candidatas em poucos minutos, porque a gestão estava operando a tela no mesmo
-- momento. Uma lista congelada de ids nasceria desatualizada e deixaria
-- títulos novos para trás -- e, pior, daria a impressão de completude.
--
-- O critério é `origem_encerramento`: ela é gravada pelo próprio sistema no
-- momento do encerramento, por quem decidiu, e já tem vocabulário fechado por
-- constraint. É a única variável independente disponível aqui.
--
-- ============================================================================
-- O QUE NÃO ENTRA, E POR QUÊ
-- ============================================================================
-- 262 títulos (R$ 2.399.695,89) com `origem_encerramento` NULA e motivo
-- "cobrança JURÍDICA" ou "portador 202 REATIVA COBRANCA JUDICIAL".
--
-- Eles NÃO são candidatos. A dívida continua existindo: ela mudou de mão, foi
-- para a cobrança judicial. Marcá-los DEVOLVIDO afirmaria que a ReATIVA
-- devolveu a dívida ao cliente, que é o contrário do que aconteceu.
--
-- A classificação deles veio do TEXTO de `motivo_ajuste`. Texto é indício, não
-- prova -- e é mais um motivo para não tocá-los: nenhum tem origem registrada,
-- então não há variável independente que sustente a conversão.
--
-- ============================================================================
-- PASSO 1 — MEDIR (só leitura, pode rodar a qualquer momento)
-- ============================================================================
select origem_encerramento,
       count(*) as titulos,
       sum(coalesce(valor_cobranca_ajustado, saldo_corrigido, valor_original,0))::numeric(14,2) as valor,
       count(distinct aluno_id) as alunos,
       count(*) filter (where origem_liquidacao is not null) as com_liquidacao_NAO_PODE_SER_MAIOR_QUE_ZERO
  from public.acordos_titulos
 where status = 'cancelada'
   and origem_encerramento in ('CANCELAMENTO_COBRANCA','CONFERENCIA_PRIME_ADMINISTRATIVA',
                               'ALEGA_FIES_CONFIRMADO','ALEGA_CREDIES_CONFIRMADO',
                               'ALEGA_FINANCIAMENTO_CONFIRMADO','ANTECIPACAO_SEMESTRE')
 group by 1 order by 2 desc;

-- ============================================================================
-- PASSO 2 — O BACKUP, que é a única forma de desfazer
-- ============================================================================
-- PITR NÃO está habilitado neste projeto. Rollback aqui não é restore: é este
-- backup mais um UPDATE de volta, por id exato, que não apague o que entrar
-- depois. Sem o passo 2 executado, o passo 3 NÃO deve rodar.
--
-- create table public.backup_cancelada_para_devolvido_20261009 as
-- select id, situacao, status, valor_em_aberto, motivo_ajuste, atualizado_em, now() as copiado_em
--   from public.acordos_titulos
--  where status = 'cancelada'
--    and origem_encerramento in ('CANCELAMENTO_COBRANCA','CONFERENCIA_PRIME_ADMINISTRATIVA',
--                                'ALEGA_FIES_CONFIRMADO','ALEGA_CREDIES_CONFIRMADO',
--                                'ALEGA_FINANCIAMENTO_CONFIRMADO','ANTECIPACAO_SEMESTRE')
--    and origem_liquidacao is null;

-- ============================================================================
-- PASSO 3 — A CONVERSÃO (COMENTADA: exige autorização)
-- ============================================================================
-- Três guardas dentro do próprio UPDATE, nenhuma delas dispensável:
--
--   `origem_liquidacao is null`  -- título com liquidação teve recuperação;
--                                   devolvê-lo apagaria dinheiro que entrou.
--   `status = 'cancelada'`       -- não mexe no que já está em outro desfecho.
--   `set_config(...decisao,'on')`-- a trava de reabertura só deixa passar por
--                                   aqui, e é ela que impede UPDATE solto.
--
-- O `motivo_ajuste` GANHA uma linha; não é sobrescrito. O motivo original, o
-- usuário e a data do encerramento ficam exatamente como estão.
--
-- begin;
--   select set_config('conferencia_prime.decisao', 'on', true);
--
--   update public.acordos_titulos
--      set situacao = 'DEVOLVIDO',
--          status   = 'devolvido',
--          valor_em_aberto = 0,
--          motivo_ajuste = coalesce(motivo_ajuste,'')
--            || ' | reclassificado de CANCELADA para DEVOLVIDO em '
--            || to_char(now(),'DD/MM/YYYY')
--            || ': encerramento sem recuperação da ReATIVA. Mesma origem, mesmo '
--            || 'motivo, mesma data. Sem pagamento, acordo ou recuperação.',
--          atualizado_em = now()
--    where status = 'cancelada'
--      and origem_liquidacao is null
--      and origem_encerramento in ('CANCELAMENTO_COBRANCA','CONFERENCIA_PRIME_ADMINISTRATIVA',
--                                  'ALEGA_FIES_CONFIRMADO','ALEGA_CREDIES_CONFIRMADO',
--                                  'ALEGA_FINANCIAMENTO_CONFIRMADO','ANTECIPACAO_SEMESTRE');
--
--   select set_config('conferencia_prime.decisao', 'off', true);
--
--   -- PASSO 4 — A PROVA, ANTES DO COMMIT. Qualquer linha aqui aborta tudo.
--   do $$
--   declare v int;
--   begin
--     select count(*) into v from public.acordos_titulos
--      where status = 'devolvido' and upper(coalesce(situacao,'')) in ('ABERTO','NEGOCIADO');
--     if v > 0 then raise exception 'DEVOLVIDO em situacao cobravel: %', v; end if;
--
--     select count(*) into v from public.acordos_titulos
--      where status = 'devolvido' and origem_liquidacao is not null;
--     if v > 0 then raise exception 'DEVOLVIDO com liquidacao: %', v; end if;
--
--     -- os judiciais seguem intocados
--     select count(*) into v from public.acordos_titulos
--      where status = 'devolvido' and origem_encerramento is null;
--     if v > 0 then raise exception 'titulo sem origem virou DEVOLVIDO: %', v; end if;
--   end $$;
-- commit;

-- ============================================================================
-- PASSO 5 — DESFAZER, se for preciso (também comentado)
-- ============================================================================
-- update public.acordos_titulos t
--    set situacao = b.situacao, status = b.status,
--        valor_em_aberto = b.valor_em_aberto, motivo_ajuste = b.motivo_ajuste
--   from public.backup_cancelada_para_devolvido_20261009 b
--  where b.id = t.id and t.status = 'devolvido';
