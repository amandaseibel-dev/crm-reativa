-- =====================================================================
-- MEDICAO DO CANARIO, ATRIBUIDA AO LOTE (nao a carteira global)
-- Preparado em 12/09/2026. 100% SELECT. Substitua :LOTE pelo importacao_id.
--
-- COMO USAR
--   1. rode MEDICAO_teste_importacao.sql  (foto global ANTES)
--   2. suba o arquivo
--   3. rode este arquivo com o importacao_id novo
--   4. rode MEDICAO_teste_importacao.sql  (foto global DEPOIS)
--   O passo 3 explica o lote; o 1 e o 4 provam que nada fora dele mudou.
--
-- JANELA LIMPA (crons que escrevem nas mesmas tabelas):
--   :30 casos_reavaliar_encerramento   :32 casos_encerrar_zerados
--   :35 casos_reabrir_com_divida       :40 fluxo_pagamentos_horario
--   todo minuto: reposicao_carteira_minuto (inerte se a fila estiver vazia)
--   Comece o teste por volta de hh:45 e feche a medicao antes de hh:28.
--   Evite 00h-09h (varredura do Prime a cada 2 min + rotinas diarias)
--   e sabado (mutirao do extrato a cada 2 min).
-- =====================================================================
\set LOTE '00000000-0000-0000-0000-000000000000'

with lote as (select id, importacao_id, aluno_id, numero_parcela_completo npc, cpf, valor_pago, data_pagamento
                from public.pagamentos where importacao_id = :'LOTE')
, imp as (select qtd_registros, arquivo_nome, created_at from public.importacoes where id = :'LOTE')
-- reconstrucao da etapa que vinculou cada linha (o gatilho nao registra; isto recalcula)
, etapa as (
  select l.id,
    case
      when l.aluno_id is null then 'SEM VINCULO'
      when exists (select 1 from public.alunos a
                    where length(nullif(regexp_replace(coalesce(l.cpf,''),'\D','','g'),'')) between 10 and 11
                      and lpad(regexp_replace(coalesce(a.cpf,''),'\D','','g'),11,'0')
                        = lpad(regexp_replace(coalesce(l.cpf,''),'\D','','g'),11,'0')
                      and a.id = l.aluno_id) then '1 CPF'
      when exists (select 1 from public.parcelas p join public.acordos a on a.id=p.acordo_id
                    where p.boleto = l.npc and a.aluno_id = l.aluno_id) then '2 BOLETO EXATO'
      when length(l.npc)=11 and (select count(distinct p.acordo_id) from public.parcelas p
             where p.boleto like '5'||substring(l.npc,2,6)||'%') = 1 then '3 PREFIXO UNICO'
      when length(l.npc)=11 and (select count(*) from public.acordos a
             where a.numero_ulbra is not null and lpad(a.numero_ulbra,6,'0')=substring(l.npc,2,6)) = 1
        then '4 NUMERO_ULBRA UNICO'
      -- nenhum identificador financeiro explica o vinculo: e a regra antiga (nome)
      -- ou um caminho novo que nao deveria existir. No canario isto tem que ser ZERO.
      else 'VINCULADO SEM IDENTIFICADOR FINANCEIRO -- INVESTIGAR'
    end et
  from lote l)
select  1 ord, 'linhas recebidas no arquivo' ponto, (select qtd_registros::text from imp) valor
union all select 2, 'linhas efetivamente inseridas', (select count(*)::text from lote)
union all select 3, 'linhas descartadas pelo guard de duplicata exata',
  ((select qtd_registros from imp) - (select count(*) from lote))::text
union all select 4, 'vinculadas: por etapa', (select string_agg(et||'='||q, ' | ' order by et) from (select et, count(*) q from etapa group by 1) x)
union all select 5, 'sem vinculo: na fila', (select count(*)::text from public.fila_pagamento_sem_vinculo where importacao_id = :'LOTE')
union all select 5, 'sem vinculo: valor e motivos',
  (select coalesce(string_agg('R$ '||to_char(valor_pago,'FM999G990D00')||' :: '||motivo, ' || '),'(nenhum)')
     from public.fila_pagamento_sem_vinculo where importacao_id = :'LOTE')
union all select 6, 'suspeita de duplicidade gerada pelo lote',
  (select count(*)::text from public.suspeitas_pagamento_duplicado s
    where s.pagamento_duplicado_id in (select id from lote) or s.pagamento_manter_id in (select id from lote)
       or s.pagamento_sugerido_duplicado_id in (select id from lote))
union all select 7, 'parcelas baixadas POR ESTE LOTE (origem_baixa_ref aponta para o pagamento)',
  (select count(*)||' parcelas / R$ '||to_char(coalesce(sum(valor),0),'FM999G999G990D00')
     from public.parcelas where origem_baixa = 'GATILHO_IMPORTACAO'
       and origem_baixa_ref in (select id::text from lote))
union all select 8, 'recusas de baixa registradas para este lote',
  (select count(*)::text from public.auditoria
    where acao = 'BAIXA_DOCUMENTO_RECUSADA' and (detalhes->>'pagamento_id')::uuid in (select id from lote))
union all select 9, 'alunos tocados pelo lote: saldo_total somado',
  (select count(*)||' alunos / R$ '||to_char(coalesce(sum(saldo_total),0),'FM999G999G990D00')
     from public.alunos where id in (select aluno_id from lote where aluno_id is not null))
union all select 9, 'movimentacoes gravadas nesses alunos depois do inicio do lote',
  (select coalesce(string_agg(tipo||'='||q, ' | ' order by tipo),'(nenhuma)') from (
     select m.tipo, count(*) q from public.aluno_movimentacoes m
      where m.aluno_id in (select aluno_id::text from lote where aluno_id is not null)
        and m.registrado_em >= (select created_at from imp) group by 1) x)
union all select 10, 'casos desses alunos alterados depois do inicio do lote',
  (select count(*)::text from public.casos c
    where c.aluno_id in (select aluno_id from lote where aluno_id is not null)
      and c.caso_atualizado_em >= (select created_at from imp))
union all select 11, 'fila da reposicao de carteira (o cron de minuto so age se houver item)',
  (select count(*)::text from public.reposicao_carteira_fila where processado_em is null)
order by ord, ponto;
