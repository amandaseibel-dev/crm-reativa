-- AUDITORIA SOMENTE LEITURA, AGREGADA. Nao retorna identificadores, CPF, boleto nem valor individual.
-- Executar em producao SOMENTE com autorizacao, em consultas isoladas (sem rotina financeira).
-- Cada bloco e independente.

-- A) Decisoes por estado e autoria (contagens)
select decisao,
       case when decidido_por is null then 'sem_autor'
            when decidido_por = 'prime_liquidacao@rotina' then 'rotina'
            else 'humano_ou_desconhecido' end as autoria,
       count(*) as n
  from public.prime_conferencia_decisao
 group by 1, 2
 order by 1, 2;

-- B) Tentativas de sobrescrita bloqueadas (desde a publicacao da correcao)
select date_trunc('day', created_at) as dia, count(*) as tentativas_bloqueadas
  from public.auditoria
 where acao = 'PRIME_SUSPENSAO_BLOQUEADA_DECISAO_HUMANA'
 group by 1
 order by 1;

-- C) Reaberturas para cobranca por mes (contagem), para comparar antes e depois
select date_trunc('month', registrado_em) as mes, count(*) as reaberturas
  from public.aluno_movimentacoes
 where tipo = 'TITULO_CONFIRMACAO_REJEITADA'
 group by 1
 order by 1;

-- D) Titulos com decisao humana ainda em cobranca (contagem e soma agregadas)
select count(*) as titulos,
       round(sum(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0))::numeric, 2) as valor_total
  from public.prime_conferencia_decisao d
  join public.acordos_titulos t on t.id = d.titulo_id
 where d.decidido_por is not null and d.decidido_por <> 'prime_liquidacao@rotina'
   and upper(coalesce(t.situacao, '')) in ('ABERTO', 'NEGOCIADO');
