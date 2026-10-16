-- ===========================================================================
-- GIRO DAS CARTEIRAS 2026/1 e 2026/2 -- CONFERENCIA DEPOIS DA EXECUCAO
--
-- SOMENTE SELECT. Rodar na ordem, trocando <SIM> pelo simulacao_id devolvido
-- por giro_2026_10_simular. Cada bloco diz o que PROVA e o que NAO prova.
--
-- Serve para duas coisas: fechar a conta do giro (blocos 1 a 4) e verificar as
-- protecoes que sustentam a carteira nova (blocos 5 a 8).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. O LOTE FECHOU. Movidos + pulados tem de bater com o total da simulacao.
--    Pulado nao e erro: e caso que mudou de dono ou ficou protegido entre a
--    simulacao e a aplicacao. Se houver pulado, o bloco 2 mostra quais.
-- ---------------------------------------------------------------------------
select
  (select (resultado->>'total_movimentacoes')::int
     from public.calibragem_simulacoes where id = '<SIM>')           as previstos,
  count(*) filter (where evento = 'MOVIMENTACAO_NIVELAMENTO')        as movidos,
  count(*) filter (where evento = 'PULADO_NIVELAMENTO')              as pulados,
  (select status from public.calibragem_simulacoes where id = '<SIM>') as status
  from public.calibragem_auditoria where simulacao_id = '<SIM>';


-- ---------------------------------------------------------------------------
-- 2. QUEM FOI PULADO, e por que. Lista curta; se vier vazia, nada foi pulado.
-- ---------------------------------------------------------------------------
select a.cpf, a.nome_aluno, a.operador_anterior_nome, a.operador_novo_nome, a.motivo
  from public.calibragem_auditoria a
 where a.simulacao_id = '<SIM>' and a.evento = 'PULADO_NIVELAMENTO'
 order by a.cpf;


-- ---------------------------------------------------------------------------
-- 3. CPFs QUE MUDARAM DE RESPONSAVEL, de verdade -- da auditoria, nao da
--    simulacao. Separa entrada de pool (sem dono antes) de troca entre
--    operadores, que e o numero que a gestao costuma querer.
-- ---------------------------------------------------------------------------
select
  count(distinct cpf)                                                   as cpfs_tocados,
  count(distinct cpf) filter (where operador_anterior_email is null)    as vieram_do_pool,
  count(distinct cpf) filter (where operador_anterior_email is not null
                                and operador_anterior_email is distinct from operador_novo_email)
                                                                        as trocaram_de_operador,
  count(distinct cpf) filter (where operador_anterior_email
                                    is not distinct from operador_novo_email)
                                                                        as ficaram_com_o_mesmo
  from public.calibragem_auditoria
 where simulacao_id = '<SIM>' and evento = 'MOVIMENTACAO_NIVELAMENTO';


-- ---------------------------------------------------------------------------
-- 4. A CARTEIRA REAL DE CADA OPERADOR DEPOIS DO GIRO.
--    Este e o numero que a tela do operador mostra: casos com ele, sem os
--    protegidos e sem os encerrados. Comparar com a coluna `ativos_depois` do
--    bloco 'teto' da simulacao -- tem de bater, ou bater muito perto (a
--    diferenca so pode vir de caso que mudou de situacao nesse meio-tempo).
-- ---------------------------------------------------------------------------
select u.nome as operador,
       count(*) filter (where c.id is not null)                        as casos_total,
       count(*) filter (where c.giro_fidelizacao_ate is not null)      as do_giro,
       count(*) filter (
         where not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento,
                 c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
           and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
                 c.status_acionamento, c.status_financeiro, c.status_jornada))  as ativos,
       public.calibragem_teto_operador(u.email)                        as teto
  from public.usuarios u
  left join public.casos c on c.operador_email = u.email
 where u.ativo and u.perfil = 'operador'
 group by u.nome, u.email
 order by u.nome;


-- ---------------------------------------------------------------------------
-- 5. O SALDO QUE FOI PARA CADA OPERADOR, pela mesma formula da simulacao.
--    PROVA que a carteira financeira ficou como simulado. NAO prova nada sobre
--    titulos que mudaram de situacao depois do giro.
-- ---------------------------------------------------------------------------
with tit as (
  select t.aluno_id,
         round(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0),2) valor,
         coalesce(ps.semestre,
           case when t.vencimento >= date '2026-01-01' and t.vencimento < date '2026-07-01' then '2026/1'
                when t.vencimento >= date '2026-07-01' and t.vencimento < date '2027-01-01' then '2026/2' end) semestre
    from public.acordos_titulos t
    left join public.prime_titulo_semestre ps on ps.boleto = t.documento
   where upper(coalesce(t.situacao,'')) = 'ABERTO' and lower(coalesce(t.status,'')) = 'em_aberto'
     and t.acordo_id is null and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id = t.id and coalesce(v.ativo, true))
     and not public.titulo_superado_por_acordo(t.aluno_id, t.vencimento)
), uni as (select * from tit where semestre in ('2026/1','2026/2') and valor > 0 and aluno_id is not null
), dono as (
  select distinct on (c.aluno_id) c.aluno_id, c.operador_email
    from public.casos c where c.giro_fidelizacao_ate is not null and c.operador_email is not null
   order by c.aluno_id, c.id
)
select u.nome as operador,
       count(distinct d.aluno_id)                                             as alunos,
       round(sum(uni.valor) filter (where uni.semestre = '2026/1'), 2)        as saldo_2026_1,
       round(sum(uni.valor) filter (where uni.semestre = '2026/2'), 2)        as saldo_2026_2,
       round(sum(uni.valor), 2)                                               as consolidado
  from dono d
  join uni on uni.aluno_id = d.aluno_id
  join public.usuarios u on u.email = d.operador_email
 group by u.nome order by u.nome;


-- ---------------------------------------------------------------------------
-- 6. O RESPONSAVEL REFLETIU NA FICHA. O caso e a ficha tem de concordar: a
--    sincronia e por gatilho (trg_sync_alunos_apos_casos), nao por escrita do
--    giro. Divergencia aqui significa gatilho que nao disparou.
-- ---------------------------------------------------------------------------
select count(*) as fichas_fora_de_sincronia
  from public.casos c
  join public.alunos a on a.id = c.aluno_id
 where c.giro_fidelizacao_ate is not null
   and lower(coalesce(a.responsavel_atual_email,'')) is distinct from lower(coalesce(c.operador_email,''));


-- ---------------------------------------------------------------------------
-- 7. A PROTECAO CONTRA ACOES MASSIVAS ESTA DE PE.
--    (a) o patch entrou na fonte unica do universo;
--    (b) os casos do giro estao marcados e dentro da data;
--    (c) a marca cobre exatamente os CPFs do giro, nem mais nem menos.
--    O que isto NAO prova: que a tela de acoes massivas foi recarregada.
-- ---------------------------------------------------------------------------
select
  position('giro_fidelizado' in
    pg_get_functiondef('public.acoes_massivas_universo(jsonb)'::regprocedure)) > 0 as universo_bloqueia,
  position('caso_em_giro_fidelizacao' in
    pg_get_functiondef('public.liberar_fidelizacao_caso(uuid,text,text)'::regprocedure)) > 0
    or position('giro_fidelizacao_ate is not null' in
    pg_get_functiondef('public.liberar_fidelizacao_caso(uuid,text,text)'::regprocedure)) > 0 as liberacao_bloqueia,
  position('giro_fidelizacao_ate IS NULL' in
    pg_get_functiondef('public.trg_impor_teto_operador()'::regprocedure)) > 0 as teto_respeita,
  position('caso_em_giro_fidelizacao' in
    pg_get_functiondef('public.assumir_caso_livre(uuid)'::regprocedure)) > 0 as assumir_conhece,
  (select count(*) from public.casos where giro_fidelizacao_ate is not null)  as casos_marcados,
  (select count(*) from public.casos
    where public.caso_em_giro_fidelizacao(giro_fidelizacao_ate))              as casos_protegidos_hoje,
  (select count(distinct caso_id) from public.calibragem_auditoria
    where simulacao_id = '<SIM>' and evento = 'MOVIMENTACAO_NIVELAMENTO')     as casos_do_giro;


-- ---------------------------------------------------------------------------
-- 8. NADA FINANCEIRO FOI TOCADO. Procura escrita em acordo, parcela ou titulo
--    na janela do giro, por qualquer caminho. Zero e o esperado.
--    Trocar a janela pelos horarios reais da execucao.
-- ---------------------------------------------------------------------------
select 'acordos' as tabela, count(*) from public.acordos
 where atualizado_em between timestamptz '<INICIO>' and timestamptz '<FIM>'
union all
select 'parcelas', count(*) from public.parcelas
 where atualizado_em between timestamptz '<INICIO>' and timestamptz '<FIM>'
union all
select 'acordos_titulos', count(*) from public.acordos_titulos
 where atualizado_em between timestamptz '<INICIO>' and timestamptz '<FIM>';


-- ---------------------------------------------------------------------------
-- 9. VIGIAS QUE JA EXISTEM. Rodar depois de qualquer rodada de calibragem.
-- ---------------------------------------------------------------------------
select public.carteira_geral_vigia();


-- ---------------------------------------------------------------------------
-- 10. SE PRECISAR DESFAZER (devolve cada caso ao dono anterior da auditoria):
--       select public.calibragem_desfazer_nivelamento_lote('<SIM>', 150);
--     Repetir ate zerar. O desfazer NAO limpa a fidelizacao do giro; para
--     limpar, depois de desfazer tudo:
--       update public.casos set giro_fidelizacao_ate = null
--        where giro_fidelizacao_ate = date '2026-10-26';
-- ---------------------------------------------------------------------------
