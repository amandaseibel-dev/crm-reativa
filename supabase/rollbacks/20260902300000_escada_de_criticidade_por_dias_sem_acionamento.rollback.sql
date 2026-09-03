-- Desfaz 20260902300000_escada_de_criticidade_por_dias_sem_acionamento.sql
--
-- Basta tirar `escada_dias` das regras e devolver `acionado_recente.max` a 10:
-- sem a chave, `calibragem_nivel_criticidade` volta a se comportar exatamente
-- como antes (o piso so existe quando `escada_dias` esta presente). A funcao e
-- o helper `criticidade_rank` podem ficar -- nao fazem nada sozinhos.
--
-- Os niveis gravados so voltam ao antigo na proxima passada do cron
-- `recalcular_situacao_virada_diaria` (06:00).

update public.calibragem_parametros
   set valor = ((valor - 'escada_dias')
         || jsonb_build_object('pesos',
              (valor->'pesos') || jsonb_build_object('acionado_recente',
                 jsonb_build_object('max', 10, 'peso', -2)))),
       atualizado_em  = now(),
       atualizado_por = 'rollback'
 where chave = 'criticidade_regras';
