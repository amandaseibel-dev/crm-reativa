-- RETROTESTE (somente leitura, contra producao) da regra de sugestao. GERADO a partir do nucleo da migration 20260922170000, trocando SO os dois trechos RETRO_*
-- pelo estado PRE-vinculo dos acordos vinculados a mao (gabarito). Resultado em 21/09/2026: 1.219 acordos do gabarito -> forte_correta=910, forte_errada=0, revisao=233, sem_evidencia=76.
with s(acordo_id, aluno_id, nome, cpf, responsavel_email, numero_acordo, status, criado_em, valor_total, saldo, nivel, motivo, liquidacao_195, composicao_hash, titulos, concorrentes, qtd_grupos_janela) as (
  with ac as materialized (
    select a.id, a.aluno_id, a.numero_acordo::text nro, upper(coalesce(a.status,'')) st, a.criado_em, a.criado_em::date cr,
           a.valor_total, coalesce(a.saldo,0) saldo, al.nome, al.cpf, regexp_replace(coalesce(al.cpf,''),'\D','','g') cpf_n,
           al.responsavel_atual_email resp
      from public.acordos a join public.alunos al on al.id = a.aluno_id
     where upper(coalesce(a.status,'')) in ('ATIVO','QUITADO')
       and true
       and exists (select 1 from public.acordo_titulo_vinculo v join public.acordos_titulos t on t.id = v.titulo_id and coalesce(t.tipo_boleto,'') <> 'Acordo' where v.acordo_id = a.id and coalesce(v.ativo,true) and v.vinculado_por ~ '@aelbra')
  ), e195 as materialized (
    select ltrim(e.boleto,'0') bol, regexp_replace(coalesce(e.cpf,''),'\D','','g') cpf_n, e.liquidado_em
      from public.prime_extrato e
     where e.portador = 195 and e.liquidado_em is not null
       and regexp_replace(coalesce(e.cpf,''),'\D','','g') in (select x.cpf_n from ac x where x.cpf_n <> '')
  ), tit as materialized (
    select t.id, t.aluno_id, t.documento, ltrim(t.documento,'0') doc, t.competencia, t.vencimento, upper(coalesce(t.situacao,'')) sit,
           lower(coalesce(t.status,'')) stt, t.acordo_id, coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) valor
      from public.acordos_titulos t
     where t.aluno_id in (select x.aluno_id from ac x) and coalesce(t.tipo_boleto,'') <> 'Acordo'
  ), el as materialized (
    select ac.id acordo_id, t.id tid, t.documento, t.competencia, t.vencimento, t.sit, t.stt, t.valor, min(e.liquidado_em) liq
      from ac join tit t on t.aluno_id = ac.aluno_id
      join e195 e on e.cpf_n = ac.cpf_n and e.bol = t.doc
     where ac.cpf_n <> '' and t.vencimento <= e.liquidado_em
       and ((t.sit = 'ABERTO' and t.acordo_id is null and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo,true))) or exists (select 1 from public.acordo_titulo_vinculo v2 where v2.titulo_id = t.id and v2.acordo_id = ac.id and coalesce(v2.ativo,true) and v2.vinculado_por ~ '@aelbra'))
     group by ac.id, t.id, t.documento, t.competencia, t.vencimento, t.sit, t.stt, t.valor
  ), gr as materialized (
    select el.acordo_id, el.liq d, jsonb_agg(jsonb_build_object('titulo_id', el.tid, 'documento', el.documento, 'competencia', el.competencia,
             'vencimento', el.vencimento, 'valor', el.valor, 'situacao', el.sit, 'status', el.stt, 'liquidacao_195', el.liq)
             order by el.vencimento, el.tid) tits, array_agg(el.tid order by el.tid) ids
      from el group by el.acordo_id, el.liq
  ), gj as materialized (
    select g.acordo_id, g.d, g.tits, g.ids, (g.d between ac.cr - 60 and ac.cr + 7) na_janela,
           (select jsonb_agg(jsonb_build_object('acordo_id', b.id, 'numero_acordo', b.numero_acordo, 'status', b.status, 'criado_em', b.criado_em::date)
                             order by b.criado_em)
              from public.acordos b
             where b.aluno_id = ac.aluno_id and b.id <> ac.id
               and g.d between b.criado_em::date - 60 and b.criado_em::date + 7) conc
      from gr g join ac on ac.id = g.acordo_id
  ), r as (
    select ac.*, (select count(*) from gj x where x.acordo_id = ac.id and x.na_janela)::int ng_win,
           (select count(*) from gj x where x.acordo_id = ac.id)::int ng_tot,
           exists (select 1 from gj x where x.acordo_id = ac.id and x.na_janela and x.conc is not null) tem_conc
      from ac
  )
  select r.id, r.aluno_id, r.nome, r.cpf, r.resp, r.nro, r.st, r.criado_em, r.valor_total, r.saldo,
         case when r.ng_win = 0 then 'SEM_EVIDENCIA' when r.ng_win = 1 and not r.tem_conc then 'FORTE' else 'REVISAO' end,
         case when r.cpf_n = '' then 'ALUNO_SEM_CPF'
              when r.ng_win = 0 and r.ng_tot = 0 then 'SEM_GRUPO_195'
              when r.ng_win = 0 then 'GRUPO_195_FORA_DA_JANELA'
              when r.ng_win > 1 then 'MULTIPLOS_GRUPOS_195'
              when r.tem_conc then 'ACORDO_CONCORRENTE'
              else 'UNICO_GRUPO_195_COMPATIVEL' end,
         (select min(x.d) from gj x where x.acordo_id = r.id and x.na_janela),
         (select md5(string_agg(q.tid::text, ',' order by q.tid)) from (select unnest(x.ids) tid from gj x where x.acordo_id = r.id and x.na_janela) q),
         coalesce((select jsonb_agg(el2 order by el2->>'vencimento', el2->>'titulo_id')
                     from gj x, jsonb_array_elements(x.tits) el2 where x.acordo_id = r.id and x.na_janela), '[]'::jsonb),
         (select jsonb_agg(distinct c) from gj x, jsonb_array_elements(x.conc) c where x.acordo_id = r.id and x.na_janela and x.conc is not null),
         r.ng_win
    from r
),
gt as materialized (select v.acordo_id, v.titulo_id from public.acordo_titulo_vinculo v join public.acordos_titulos t on t.id=v.titulo_id and coalesce(t.tipo_boleto,'')<>'Acordo' where coalesce(v.ativo,true) and v.vinculado_por ~ '@aelbra'),
gtd as materialized (select gt.acordo_id, e.liquidado_em d from gt join public.acordos_titulos t on t.id=gt.titulo_id join public.prime_extrato e on e.portador=195 and ltrim(e.boleto,'0')=ltrim(t.documento,'0') group by 1,2),
gt1 as materialized (select acordo_id, min(d) d_gt from gtd group by 1 having count(*)=1),
gts as materialized (select acordo_id, array_agg(titulo_id order by titulo_id) ids from gt group by 1),
sug as (select s.acordo_id, s.nivel, s.motivo, s.liquidacao_195, (select array_agg((x->>'titulo_id')::uuid order by (x->>'titulo_id')::uuid) from jsonb_array_elements(s.titulos) x) ids from s)
select count(*) acordos_gabarito,
  count(*) filter (where sug.nivel='FORTE' and sug.liquidacao_195=gt1.d_gt and sug.ids=gts.ids) forte_correta,
  count(*) filter (where sug.nivel='FORTE' and not (sug.liquidacao_195=gt1.d_gt and sug.ids=gts.ids)) forte_errada,
  count(*) filter (where sug.nivel='REVISAO') revisao, count(*) filter (where sug.nivel='SEM_EVIDENCIA') sem_evidencia, count(*) filter (where sug.acordo_id is null) fora_do_calculo
from gt1 join gts using (acordo_id) left join sug on sug.acordo_id=gt1.acordo_id;
