-- ============================================================================
-- 5/5 -- VALIDACAO ANTES / DEPOIS -- 100% SELECT, nao escreve nada
-- ============================================================================
-- Rodar INTEIRO antes de aplicar (arquivos 1 a 4) e INTEIRO depois. Cada bloco
-- traz, no comentario, o numero MEDIDO EM PRODUCAO em 24/09/2026 (o "antes") e
-- o numero ESPERADO depois. O que nao tem de mudar esta marcado "= igual".
--
-- Ordem de aplicacao pensada: 1 (estrutural) -> 2 (G1) -> 3 (G2-A) -> 4 (Suelen)
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. A FOTO QUE ORIGINOU TUDO: situacao da mensalidade x status do acordo
-- ---------------------------------------------------------------------------
-- ANTES (24/09/2026):
--   NEGOCIADO x ATIVO     3.059   R$ 6.490.212,19
--   NEGOCIADO x CANCELADO    16   R$     3.412,90
--   NEGOCIADO x QUITADO      65   R$    41.642,41   <= G1, tem de ir a zero
--   PAGO      x ATIVO       538   R$   838.224,10   <= 492 saem, ficam 46
--   PAGO      x CANCELADO    15   R$     8.472,64
--   PAGO      x QUITADO   1.081   R$ 1.316.978,35
-- DEPOIS esperado:
--   NEGOCIADO x QUITADO       0
--   PAGO      x ATIVO        46   (C 17 + D 21 + E1 5 + E2 3)
--   NEGOCIADO x ATIVO     3.551   (3.059 + 492)
--   PAGO      x QUITADO   1.146   (1.081 + 65)
select t.situacao as situacao_mensalidade,
       coalesce(a.status,'(sem acordo)') as status_acordo,
       count(*) as qtd,
       round(sum(coalesce(t.saldo_corrigido,0)),2) as saldo_corrigido
  from public.acordos_titulos t
  left join public.acordos a on a.id = t.acordo_id
 where t.acordo_id is not null
 group by 1,2 order by 1,2;


-- ---------------------------------------------------------------------------
-- 2. AS DUAS INVARIANTES PEDIDAS
-- ---------------------------------------------------------------------------
-- ANTES: negociado_em_acordo_quitado = 65 | pago_por_consequencia_do_acordo = 492
-- DEPOIS: os dois = 0. As excecoes documentadas (C=17, D=21) NAO entram aqui:
-- a segunda conta so quem tem a prova de auditoria de ter sido quitado pelo
-- acordo, que e exatamente o criterio do grupo A.
select
  (select count(*) from public.acordos_titulos t join public.acordos a on a.id=t.acordo_id
    where upper(coalesce(t.situacao,''))='NEGOCIADO' and upper(coalesce(a.status,''))='QUITADO'
  ) as negociado_em_acordo_quitado,
  (select count(*)
     from (select t.id, t.acordo_id,
                  (select l2.criado_em from public.audit_log l2
                    where l2.tabela='acordos_titulos' and l2.registro_id=t.id::text
                      and upper(coalesce(l2.dados_depois->>'situacao',''))='PAGO'
                      and upper(coalesce(l2.dados_antes->>'situacao',''))<>'PAGO'
                    order by l2.criado_em desc limit 1) as quando
             from public.acordos_titulos t join public.acordos a on a.id=t.acordo_id
            where upper(coalesce(t.situacao,''))='PAGO' and upper(coalesce(a.status,''))='ATIVO'
              and t.tipo_boleto is distinct from 'Acordo') x
    where x.quando is not null
      and exists (select 1 from public.audit_log la
                   where la.tabela='acordos' and la.registro_id=x.acordo_id::text
                     and la.criado_em = x.quando
                     and upper(coalesce(la.dados_depois->>'status',''))='QUITADO')
  ) as pago_por_consequencia_do_acordo;


-- ---------------------------------------------------------------------------
-- 3. DUPLA CONTAGEM (mensalidade que soma no saldo tendo acordo vivo)
-- ---------------------------------------------------------------------------
-- ANTES: 17 titulos / R$ 3.841,62 -- sendo 16 de acordo CANCELADO (divida volta
--        de proposito, regra de 22/09) e 1 a Suelen, R$ 428,72, que e dobra real.
-- DEPOIS esperado: 16 titulos / R$ 3.412,90. Nenhum com acordo vivo.
select count(*) as negociado_orfao_qtd,
       round(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)),2) as valor,
       count(*) filter (where exists (select 1 from public.acordos a
                                       where a.id = t.acordo_id
                                         and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')))
         as dobra_real_com_acordo_vivo
  from public.acordos_titulos t
 where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
   and not exists (select 1 from public.acordo_titulo_vinculo v join public.acordos a on a.id = v.acordo_id
                    where v.titulo_id = t.id and coalesce(v.ativo, true)
                      and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));
-- e tambem: titulo ABERTO nunca pode ter acordo. ANTES 0 / DEPOIS 0.
select count(*) as aberto_com_acordo
  from public.acordos_titulos t
 where upper(coalesce(t.situacao,'')) = 'ABERTO'
   and (t.acordo_id is not null
        or exists (select 1 from public.acordo_titulo_vinculo v join public.acordos a on a.id=v.acordo_id
                    where v.titulo_id=t.id and coalesce(v.ativo,true)
                      and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')));


-- ---------------------------------------------------------------------------
-- 4. SALDO -- GLOBAL. TEM DE FICAR IGUAL, ATE O CENTAVO (menos a Suelen)
-- ---------------------------------------------------------------------------
-- ANTES (24/09/2026):
--   saldo_total    R$ 43.137.668,05
--   saldo_vencido  R$ 37.435.537,87
--   alunos com saldo        12.896
-- DEPOIS esperado: IGUAL, exceto -R$ 428,72 no saldo da Suelen quando o
-- arquivo 4 rodar (e so apos o recalculo do aluno). Os arquivos 2 e 3 NAO
-- mexem em saldo: PAGO e NEGOCIADO-com-vinculo-vivo estao os dois FORA da
-- conta em `aluno_saldo_pendente_detalhe` e em `saude_carteira_panorama`.
select round(sum(coalesce(saldo_total,0)),2) as saldo_total_global,
       round(sum(coalesce(saldo_vencido,0)),2) as saldo_vencido_global,
       count(*) filter (where coalesce(saldo_total,0) > 0) as alunos_com_saldo
  from public.alunos;


-- ---------------------------------------------------------------------------
-- 5. SALDO -- SO OS ALUNOS AFETADOS
-- ---------------------------------------------------------------------------
-- ANTES: 212 alunos | saldo_total R$ 619.926,08 | saldo_vencido R$ 188.911,73
-- DEPOIS esperado: mesmos valores (-R$ 428,72 no total depois do arquivo 4).
-- A lista de alunos e reconstruida pelos backups, para dar a mesma resposta
-- antes e depois. Se os backups ainda nao existirem, cai na definicao original.
with afetados as (
  select distinct aluno_id from (
    select t.aluno_id
      from public.acordos_titulos t join public.acordos a on a.id = t.acordo_id
     where (upper(coalesce(t.situacao,''))='NEGOCIADO' and upper(coalesce(a.status,''))='QUITADO')
        or (upper(coalesce(t.situacao,''))='PAGO' and upper(coalesce(a.status,''))='ATIVO')
        or t.id = 'caa99e1e-4f70-48c6-9a37-0993e75fa306'
    union
    select t.aluno_id from public.acordos_titulos t
     where t.id in (select titulo_id from public._backup_saneamento_g1_20260924)
        or t.id in (select titulo_id from public._backup_saneamento_g2a_20260924)
  ) x
)
select count(*) as alunos_afetados,
       round(sum(coalesce(al.saldo_total,0)),2) as saldo_total_afetados,
       round(sum(coalesce(al.saldo_vencido,0)),2) as saldo_vencido_afetados
  from afetados f join public.alunos al on al.id = f.aluno_id;


-- ---------------------------------------------------------------------------
-- 6. EFETIVIDADE x NEGOCIADO -- o numero que MUDA de proposito
-- ---------------------------------------------------------------------------
-- PRECISA DE PERMISSAO DE GESTAO (a funcao e SECURITY DEFINER com GRANT
-- restrito -- de `permission denied` em conexao read-only). Rodar no SQL Editor
-- como postgres, ou pela tela.
-- ANTES: anotar o resultado aqui na primeira execucao ______________________
-- DEPOIS esperado: ef_pago cai ~R$ 830 mil (os 492 saem de "pago") e sobe
-- ~R$ 41,6 mil (os 65 entram); ef_negociado faz o caminho inverso. A SOMA das
-- duas colunas nao muda: nenhum titulo entra nem sai da base, so troca de balde.
select count(*) as titulos,
       round(coalesce(sum(ef_pago),0),2)      as ef_pago,
       round(coalesce(sum(ef_negociado),0),2) as ef_negociado,
       round(coalesce(sum(ef_convertido),0),2) as ef_convertido,
       round(coalesce(sum(em_validacao),0),2)  as em_validacao,
       round(coalesce(sum(inadimplencia),0),2) as inadimplencia
  from public.carteira_2026_1_classificar();

-- Alternativa sem permissao especial: a mesma troca de balde, contada na fonte
-- ANTES:  PAGO 5.341 | NEGOCIADO 3.140
-- DEPOIS: PAGO 4.914 | NEGOCIADO 3.567   (-492 +65 / +492 -65)
select upper(coalesce(situacao,'(null)')) as situacao, count(*) as qtd,
       round(sum(coalesce(saldo_corrigido, valor_em_aberto, valor_original, 0)),2) as valor
  from public.acordos_titulos
 where upper(coalesce(situacao,'')) in ('PAGO','NEGOCIADO')
 group by 1 order by 1;


-- ---------------------------------------------------------------------------
-- 7. NADA DE PAGAMENTO FOI TOCADO
-- ---------------------------------------------------------------------------
-- ANTES = DEPOIS, obrigatoriamente. Nenhum dos arquivos escreve em pagamentos,
-- parcelas, baixas ou confirmacoes.
select
  (select count(*) from public.pagamentos) as pagamentos,
  (select round(sum(coalesce(valor_pago,0)),2) from public.pagamentos) as valor_pago_total,
  (select count(*) from public.parcelas where upper(coalesce(status,''))='PAGO') as parcelas_pagas,
  (select round(sum(coalesce(valor,0)),2) from public.parcelas where upper(coalesce(status,''))='PAGO') as valor_parcelas_pagas,
  (select count(*) from public.parcelas where upper(coalesce(status,'')) in ('A_VENCER','VENCIDA')) as parcelas_vivas,
  (select count(*) from public.acordo_titulo_vinculo where coalesce(ativo,true)) as vinculos_ativos,
  (select count(*) from public.acordos where upper(coalesce(status,''))='ATIVO') as acordos_ativos,
  (select count(*) from public.acordos where upper(coalesce(status,''))='QUITADO') as acordos_quitados,
  (select count(*) from public.acordos_titulos where origem_liquidacao is not null) as titulos_com_liquidacao_prime;


-- ---------------------------------------------------------------------------
-- 8. OS GRUPOS QUE FICARAM DE FORA CONTINUAM INTACTOS
-- ---------------------------------------------------------------------------
-- ANTES = DEPOIS: C = 17 / R$ 6.030,79 ; D = 21 / R$ 8.181,97 ; E1 = 5 / R$ 0,00 ; E2 = 3 / R$ 0,00
with ev as (
  select t.id, t.tipo_boleto, t.acordo_id,
         coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original,0) valor,
         (select l.id from public.audit_log l
           where l.tabela='acordos_titulos' and l.registro_id=t.id::text
             and upper(coalesce(l.dados_depois->>'situacao',''))='PAGO'
             and upper(coalesce(l.dados_antes->>'situacao',''))<>'PAGO'
           order by l.criado_em desc, l.id desc limit 1) audit_id
    from public.acordos_titulos t join public.acordos a on a.id=t.acordo_id
   where upper(coalesce(t.situacao,''))='PAGO' and upper(coalesce(a.status,''))='ATIVO'
)
select case
         when coalesce(tipo_boleto,'')='Acordo' then 'C: boleto do proprio acordo'
         when not exists (select 1 from public.audit_log la
                           join public.audit_log al on al.id = ev.audit_id
                          where la.tabela='acordos' and la.registro_id=ev.acordo_id::text
                            and la.criado_em = al.criado_em
                            and upper(coalesce(la.dados_depois->>'status',''))='QUITADO')
           then 'D: quitado pela liquidacao Prime (portador 195)'
         when exists (select 1 from public.audit_log al where al.id=ev.audit_id
                       and (al.dados_antes->'saldo_corrigido' is distinct from al.dados_depois->'saldo_corrigido'
                         or al.dados_antes->'valor_em_aberto' is distinct from al.dados_depois->'valor_em_aberto'))
           then 'E1: quitacao manual que zerou o valor'
         else 'E2: intervencao posterior mexeu no valor' end as grupo,
       count(*) qtd, round(sum(valor),2) valor
  from ev group by 1 order by 1;

-- ---------------------------------------------------------------------------
-- 9. O QUE FOI MEXIDO, LINHA A LINHA (so roda depois -- le os backups)
-- ---------------------------------------------------------------------------
-- Esperado: G1 = 65 | G2-A = 492 | total 557 titulos (Suelen so se a opcao 1 rodar)
select 'G1' as lote, count(*) as titulos,
       round(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original,0)),2) as valor,
       count(distinct t.aluno_id) as alunos,
       count(*) filter (where upper(coalesce(t.situacao,''))='PAGO' and lower(coalesce(t.status,''))='quitada') as no_estado_esperado
  from public._backup_saneamento_g1_20260924 b join public.acordos_titulos t on t.id = b.titulo_id
union all
select 'G2-A', count(*),
       round(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original,0)),2),
       count(distinct t.aluno_id),
       count(*) filter (where upper(coalesce(t.situacao,''))='NEGOCIADO' and lower(coalesce(t.status,''))='vinculada')
  from public._backup_saneamento_g2a_20260924 b join public.acordos_titulos t on t.id = b.titulo_id
union all
select 'Suelen', count(*),
       round(sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original,0)),2),
       count(distinct t.aluno_id),
       count(*) filter (where upper(coalesce(t.situacao,''))='NEGOCIADO' and lower(coalesce(t.status,''))='vinculada')
  from public._backup_saneamento_suelen_20260924 b join public.acordos_titulos t on t.id = b.titulo_id;


-- ---------------------------------------------------------------------------
-- 10. A REGRA NOVA ESTA VALENDO E NAO PEGOU NINGUEM DE SURPRESA
-- ---------------------------------------------------------------------------
-- Depois do arquivo 1 e ANTES do 3: tem de ser 0 (ninguem tem proveniencia).
-- Depois do 3: tem de ser 0 de novo (o motor limpa ao reabrir); a partir dai
-- so cresce conforme acordos novos forem sendo quitados.
select count(*) as titulos_com_proveniencia_de_acordo,
       count(*) filter (where quitacao_origem_acordo_id is null) as sem_acordo_na_proveniencia
  from public.acordos_titulos where quitacao_origem is not null;
