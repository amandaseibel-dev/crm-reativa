-- ============================================================================
-- ROLLBACK do arquivo 3 (G2-A, 492 titulos) -- por ID, contra o ESTADO DEIXADO
-- ============================================================================
-- Restaura o que foi gravado em `_backup_saneamento_g2a_20260924`, titulo por
-- titulo: devolve os 492 de NEGOCIADO/vinculada para PAGO/quitada.
--
-- POR QUE A VERSAO ANTERIOR NAO SERVIA
-- Ela aceitava qualquer titulo que estivesse hoje em PAGO/quitada -- o par que
-- o saneamento deveria ter deixado. Mas esse par nao identifica o estado: outra
-- coisa pode ter reescrito o registro depois e chegado no MESMO par com motivo,
-- acordo ou proveniencia diferentes, e o rollback sobrescreveria por cima,
-- apagando trabalho posterior sem avisar.
--
-- O QUE ESTA VERSAO EXIGE, POR TITULO
--   (1) igualdade campo a campo com a fotografia gravada no momento da
--       correcao (`*_pos`) -- exatamente os campos que este arquivo sobrescreve;
--   (2) nenhum evento em `audit_log` com `id > audit_log_id_pos` que tenha
--       tocado campo relevante. A marca-d'agua e o maior audit_log.id daquele
--       titulo no fim da correcao: id maior veio depois de nos;
--   (3) nenhuma marca de liquidacao independente que tenha aparecido depois.
--       Aqui a restauracao devolve o titulo para PAGO -- e se entrou pagamento
--       de verdade no meio, o PAGO de hoje passou a ter OUTRA causa. Restaurar
--       apagaria a proveniencia correta por cima. Recusa e deixa para decisao.
--
-- Falhando qualquer uma, o titulo e RECUSADO -- so ele, nominalmente, com o
-- motivo. Os demais voltam.
--
-- Nao apaga pagamento, nao apaga vinculo, nao toca em parcela, nao toca em
-- acordo. So devolve situacao/status/acordo_id/motivo/proveniencia do titulo.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0) O backup existe e tem fotografia posterior?
-- ---------------------------------------------------------------------------
do $$
declare v_qtd int; v_sem_foto int;
begin
  select count(*) into v_qtd from public._backup_saneamento_g2a_20260924;
  if v_qtd <> 492 then
    raise exception 'ABORTA: backup tem % linhas, esperado 492 -- confira a tabela antes', v_qtd;
  end if;

  select count(*) into v_sem_foto from public._backup_saneamento_g2a_20260924
   where registro_pos is null or audit_log_id_pos is null;
  if v_sem_foto > 0 then
    raise exception 'ABORTA: % linha(s) sem fotografia posterior. O saneamento foi rodado por uma versao antiga do arquivo 3, sem o bloco 5. Sem ela nao ha com o que comparar, e este rollback NAO vai adivinhar -- reverta a mao, titulo por titulo.', v_sem_foto;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1) DECISAO POR TITULO -- motivo nulo = pode voltar
-- ---------------------------------------------------------------------------
create temporary table _g2a_rev on commit drop as
select b.titulo_id,
       case
         when t.id is null then
           'o titulo nao existe mais'

         -- (1) igualdade campo a campo com o que a correcao deixou
         when t.situacao is distinct from b.situacao_pos then
           'situacao mudou depois da correcao: deixei ' || coalesce(b.situacao_pos,'(nulo)')
             || ', esta ' || coalesce(t.situacao,'(nulo)')
         when t.status is distinct from b.status_pos then
           'status mudou depois da correcao: deixei ' || coalesce(b.status_pos,'(nulo)')
             || ', esta ' || coalesce(t.status,'(nulo)')
         when t.acordo_id is distinct from b.acordo_id_pos then
           'acordo_id mudou depois da correcao'
         when t.motivo_ajuste is distinct from b.motivo_ajuste_pos then
           'motivo_ajuste foi reescrito depois da correcao'
         when t.quitacao_origem is distinct from b.quitacao_origem_pos then
           'quitacao_origem mudou depois da correcao'
         when t.quitacao_origem_acordo_id is distinct from b.quitacao_origem_acordo_id_pos then
           'quitacao_origem_acordo_id mudou depois da correcao'
         when t.quitacao_origem_em is distinct from b.quitacao_origem_em_pos then
           'quitacao_origem_em mudou depois da correcao'
         when t.saldo_corrigido is distinct from b.saldo_corrigido_pos
           or t.valor_em_aberto is distinct from b.valor_em_aberto_pos then
           'o VALOR do titulo mudou depois da correcao -- nao restaurar sem conferir'

         -- (2) evento posterior a marca-d'agua que tocou campo relevante
         when exists (
           select 1 from public.audit_log l
            where l.tabela = 'acordos_titulos'
              and l.registro_id = b.titulo_id::text
              and l.id > b.audit_log_id_pos
              and (l.dados_depois->'situacao'                  is distinct from l.dados_antes->'situacao'
                or l.dados_depois->'status'                    is distinct from l.dados_antes->'status'
                or l.dados_depois->'acordo_id'                 is distinct from l.dados_antes->'acordo_id'
                or l.dados_depois->'motivo_ajuste'             is distinct from l.dados_antes->'motivo_ajuste'
                or l.dados_depois->'quitacao_origem'           is distinct from l.dados_antes->'quitacao_origem'
                or l.dados_depois->'quitacao_origem_acordo_id' is distinct from l.dados_antes->'quitacao_origem_acordo_id'
                or l.dados_depois->'saldo_corrigido'           is distinct from l.dados_antes->'saldo_corrigido'
                or l.dados_depois->'valor_em_aberto'           is distinct from l.dados_antes->'valor_em_aberto'
                or l.dados_depois->'origem_liquidacao'         is distinct from l.dados_antes->'origem_liquidacao'
                or l.dados_depois->'origem_encerramento'       is distinct from l.dados_antes->'origem_encerramento')) then
           'houve evento posterior no audit_log tocando campo relevante (id > '
             || b.audit_log_id_pos || ')'

         -- (3) liquidacao independente que apareceu depois
         when t.origem_liquidacao is not null or t.origem_encerramento is not null then
           'ganhou marca de liquidacao/encerramento depois da correcao'
         when exists (
           select 1 from public.pagamentos pg
            where regexp_replace(coalesce(pg.titulo_numero,''),'\D','','g') <> ''
              and regexp_replace(coalesce(pg.titulo_numero,''),'\D','','g')
                = regexp_replace(coalesce(t.documento,''),'\D','','g')) then
           'apareceu pagamento proprio em pagamentos -- o PAGO passou a ter outra causa, nao restaurar por cima'
         when exists (
           select 1 from public.conferencia_pagamentos cp
            where regexp_replace(coalesce(cp.titulo_numero,''),'\D','','g') <> ''
              and regexp_replace(coalesce(cp.titulo_numero,''),'\D','','g')
                = regexp_replace(coalesce(t.documento,''),'\D','','g')) then
           'apareceu registro em conferencia_pagamentos'
         when exists (
           select 1 from public.solicitacoes_confirmacao_pagamento s
            where s.titulo_id = b.titulo_id) then
           'apareceu solicitacao de confirmacao de pagamento'

         else null
       end as motivo_recusa
  from public._backup_saneamento_g2a_20260924 b
  left join public.acordos_titulos t on t.id = b.titulo_id;

-- ---------------------------------------------------------------------------
-- 2) A RESTAURACAO -- so os aprovados
-- ---------------------------------------------------------------------------
update public.acordos_titulos t
   set situacao   = b.situacao_anterior,
       status     = b.status_anterior,
       acordo_id  = b.acordo_id_anterior,
       motivo_ajuste = b.motivo_ajuste_anterior,
       quitacao_origem = b.quitacao_origem_anterior,
       quitacao_origem_acordo_id = b.quitacao_origem_acordo_id_anterior,
       quitacao_origem_em = null,
       atualizado_em = now()
  from public._backup_saneamento_g2a_20260924 b
 where t.id = b.titulo_id
   and t.id in (select titulo_id from _g2a_rev where motivo_recusa is null);

-- ---------------------------------------------------------------------------
-- 3) CONFERENCIA: o que voltou, voltou para o estado anterior exato?
-- ---------------------------------------------------------------------------
do $$
declare v_rev int; v_rec int; v_falha int;
begin
  select count(*) into v_rev from _g2a_rev where motivo_recusa is null;
  select count(*) into v_rec from _g2a_rev where motivo_recusa is not null;

  select count(*) into v_falha
    from _g2a_rev r
    join public._backup_saneamento_g2a_20260924 b on b.titulo_id = r.titulo_id
    join public.acordos_titulos t on t.id = r.titulo_id
   where r.motivo_recusa is null
     and (t.situacao is distinct from b.situacao_anterior
       or t.status   is distinct from b.status_anterior
       or t.acordo_id is distinct from b.acordo_id_anterior);
  if v_falha > 0 then
    raise exception 'ABORTA: % titulo(s) nao voltaram ao estado anterior exato', v_falha;
  end if;

  raise notice 'REVERTIDOS: % | RECUSADOS: % (lista abaixo, com motivo)', v_rev, v_rec;
end $$;

-- ---------------------------------------------------------------------------
-- 4) OS RECUSADOS, nominalmente e com motivo
-- ---------------------------------------------------------------------------
select r.titulo_id,
       t.documento,
       b.situacao_pos  as deixei_situacao,
       b.status_pos    as deixei_status,
       t.situacao      as situacao_hoje,
       t.status        as status_hoje,
       b.audit_log_id_pos,
       (select max(l.id) from public.audit_log l
         where l.tabela = 'acordos_titulos' and l.registro_id = r.titulo_id::text) as audit_log_id_hoje,
       r.motivo_recusa
  from _g2a_rev r
  join public._backup_saneamento_g2a_20260924 b on b.titulo_id = r.titulo_id
  left join public.acordos_titulos t on t.id = r.titulo_id
 where r.motivo_recusa is not null
 order by r.motivo_recusa, t.documento;

commit;

-- A tabela de backup NAO e derrubada: ela e a prova do que foi feito, e o
-- registro de quais titulos foram recusados na volta.
-- Para descartar depois de tudo conferido:
--   drop table public._backup_saneamento_g2a_20260924;
