-- PRESERVA O BOLETO DA PARCELA NA IMPORTACAO DE ACORDOS
-- =============================================================================
-- O DEFEITO. `completar_parcelas_acordo()` cria a parcela a partir da linha de
-- `acordos_titulos` e, no mesmo passo, move essa linha para quarentena e a
-- APAGA. O `documento` -- que e o boleto da parcela, 12 digitos no formato
-- 050 + acordo(5) + parcela(4) -- estava em maos dentro do loop e NAO era
-- gravado: a coluna `boleto` nao constava do INSERT. Resultado medido em
-- 15/09/2026: 2.634 parcelas com `boleto` nulo, e 203 pagamentos Santander
-- (R$ 275.321,72, 87 acordos) que o motor de conciliacao identifica o acordo
-- mas nao consegue amarrar a parcela.
--
-- A CORRECAO. Duas linhas: o cursor interno passa a expor o documento
-- normalizado, e o INSERT passa a grava-lo em `parcelas.boleto`.
--
-- POR QUE E DETERMINISTICO. Nao ha busca, join ou escolha. A parcela e criada
-- DENTRO da iteracao que le o titulo; `t.boleto` e o documento da propria
-- linha-fonte. Sufixo, valor e data nao participam.
--
-- POR QUE `ltrim(...,'0')`. O CRM guarda o boleto com 11 digitos, sem o zero a
-- esquerda. Medido em 15/09/2026: os 12.461 `parcelas.boleto` preenchidos estao
-- em `^5[0-9]{10}$`, e as 13.087 linhas-fonte com documento de 12 digitos
-- normalizam para esse mesmo formato -- 13.087 de 13.087. A forma nao
-- normalizada nao aparece uma unica vez em `parcelas.boleto`: 0 de 13.087.
-- Gravar 12 digitos quebraria o `BOLETO_EXATO` do motor.
--
-- O QUE ESTA MIGRATION NAO FAZ:
--   * nao atualiza parcela historica -- a funcao so age em acordo que ainda nao
--     tem nenhuma parcela, invariante ja existente e preservada;
--   * nao faz backfill;
--   * nao toca `pagamento_conciliar_um` nem estado de conciliacao;
--   * nao mexe em `acordos_titulos.dados`;
--   * NAO valida `parcelas.numero`. A regra `numero = right(documento,2)`
--     continua exatamente como estava. Sabe-se que o sufixo do boleto coincide
--     com o numero da parcela em apenas 42% dos casos (5.157 de 12.150 medidos
--     em 15/09/2026) -- e divida conhecida, fora do escopo, e NAO e usada como
--     evidencia desta correcao.
--
-- Assinatura, owner, SECURITY DEFINER, search_path, gate, backups, dry-run,
-- limite e guarda de divergencia: todos preservados sem alteracao.

create or replace function public.completar_parcelas_acordo(
  p_limite integer default 5,
  p_dry_run boolean default true,
  p_lote text default null::text,
  p_executado_por text default 'completar_parcelas_acordo'::text)
 returns table(acordo_id uuid, numero_acordo bigint, aluno_id uuid,
               qtd_parcelas integer, valor_total numeric, acao text)
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  r record; t record;
  v_n int := 0;
  v_lote text := coalesce(p_lote, to_char(now(),'YYYYMMDDHH24MISS'));
  v_pid uuid; v_qtd int; v_soma numeric;
begin
  if not public._gate_completar_parcelas() then
    raise exception 'Acesso negado: completar_parcelas_acordo exige permissao de importacao ou gestao de acordos.' using errcode='42501';
  end if;

  for r in
    with alvo as (
      select a.id, a.aluno_id, a.numero_acordo, a.valor_total
      from public.acordos a
      where upper(coalesce(a.status,''))='ATIVO'
        and not exists (select 1 from public.parcelas pa where pa.acordo_id=a.id)
    ),
    qbase as (
      select t2.aluno_id,
        left(regexp_replace(t2.documento,'\D','','g'), length(regexp_replace(t2.documento,'\D','','g'))-2) as base,
        count(*) qtd, round(sum(coalesce(t2.valor_original,t2.valor_em_aberto,0)),2) soma
      from public.acordos_titulos t2
      where length(regexp_replace(coalesce(t2.documento,''),'\D','','g')) >= 10
      group by 1,2
    )
    select alvo.id, alvo.aluno_id, alvo.numero_acordo, alvo.valor_total, qb.base, qb.qtd, qb.soma
    from alvo
    join qbase qb on qb.aluno_id=alvo.aluno_id and abs(qb.soma-alvo.valor_total)<=0.02
    where (select count(*) from qbase qx where qx.aluno_id=alvo.aluno_id and abs(qx.soma-alvo.valor_total)<=0.02)=1
      and (select count(*) from public.acordos a2 where a2.aluno_id=alvo.aluno_id and abs(a2.valor_total-alvo.valor_total)<=0.02
             and upper(coalesce(a2.status,''))='ATIVO' and not exists (select 1 from public.parcelas pa where pa.acordo_id=a2.id))=1
    order by alvo.numero_acordo
  loop
    exit when v_n >= coalesce(p_limite, 2147483647);
    acordo_id:=r.id; numero_acordo:=r.numero_acordo; aluno_id:=r.aluno_id; valor_total:=r.valor_total; qtd_parcelas:=r.qtd;
    if p_dry_run then acao:='DRY_RUN'; return next; v_n:=v_n+1; continue; end if;

    v_qtd:=0; v_soma:=0;
    for t in
      select tt.id, right(regexp_replace(tt.documento,'\D','','g'),2)::int as numero,
             coalesce(tt.valor_original,tt.valor_em_aberto,0) as valor, tt.vencimento,
             -- ACRESCENTADO: o boleto da PROPRIA linha-fonte, normalizado para o
             -- formato de 11 digitos que o CRM usa. Nao deriva de numero, valor
             -- nem vencimento.
             ltrim(regexp_replace(tt.documento,'\D','','g'),'0') as boleto,
             to_jsonb(tt.*) as snap
      from public.acordos_titulos tt
      where tt.aluno_id=r.aluno_id
        and length(regexp_replace(coalesce(tt.documento,''),'\D','','g'))>=10
        and left(regexp_replace(tt.documento,'\D','','g'), length(regexp_replace(tt.documento,'\D','','g'))-2)=r.base
      order by 1
    loop
      v_pid:=gen_random_uuid();
      -- ACRESCENTADO no INSERT: a coluna `boleto`, alimentada por t.boleto.
      insert into public.parcelas(id,acordo_id,numero,valor,vencimento,status,is_entrada,boleto,observacao,criado_em,atualizado_em)
      values(v_pid,r.id,t.numero,t.valor,t.vencimento,
             case when t.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,false,
             t.boleto,
             'Gerada da importacao (lote '||v_lote||') a partir do titulo do acordo; titulo movido p/ quarentena (sem dobra).',now(),now());
      insert into public._backup_completar_parcelas_lote(lote,acordo_id,acao,parcela_id,executado_por)
      values(v_lote,r.id,'PARCELA_CRIADA',v_pid,p_executado_por);

      insert into public._backup_parcelas_acordo_erro_import
        (id,aluno_id,cpf,documento,vencimento,valor_original,saldo_corrigido,situacao,tipo_boleto,dados,importacao_id,created_at,status,valor_em_aberto,competencia,motivo_ajuste,atualizado_em,acordo_id,vinculado_em,vinculado_por)
      select src.id,src.aluno_id,src.cpf,src.documento,src.vencimento,src.valor_original,src.saldo_corrigido,src.situacao,src.tipo_boleto,src.dados,src.importacao_id,src.created_at,src.status,src.valor_em_aberto,src.competencia,
             'Movido p/ quarentena ao gerar parcela do acordo (lote '||v_lote||') - evita dobra',src.atualizado_em,src.acordo_id,src.vinculado_em,src.vinculado_por
      from public.acordos_titulos src where src.id=t.id;
      insert into public._backup_completar_parcelas_lote(lote,acordo_id,acao,titulo_id,titulo_snapshot,executado_por)
      values(v_lote,r.id,'TITULO_QUARENTENA',t.id,t.snap,p_executado_por);
      delete from public.acordos_titulos src where src.id=t.id;

      v_qtd:=v_qtd+1; v_soma:=v_soma+coalesce(t.valor,0);
    end loop;
    if abs(v_soma-r.valor_total)>0.02 then
      raise exception 'Divergencia acordo %: soma parcelas % <> valor_total %', r.numero_acordo, v_soma, r.valor_total;
    end if;
    acao:='COMPLETADO('||v_qtd||')'; return next; v_n:=v_n+1;
  end loop;
end;
$fn$;

comment on function public.completar_parcelas_acordo(integer, boolean, text, text) is
  'Cria as parcelas de acordo ATIVO que ainda nao tem nenhuma, a partir dos titulos de acordo do mesmo aluno cuja base (documento sem os 2 ultimos digitos) e unica e cuja soma bate com valor_total. Desde 15/09/2026 grava tambem parcelas.boleto, copiado da linha-fonte (ltrim do documento, 11 digitos) na mesma iteracao -- sem join e sem aproximacao. NAO valida parcelas.numero, que segue derivado de right(documento,2).';
