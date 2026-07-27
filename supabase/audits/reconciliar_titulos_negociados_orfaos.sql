-- AUDITORIA / ANALISE -- NAO E MIGRATION, NAO EXECUTAR AUTOMATICAMENTE.
--
-- Este arquivo vive em supabase/audits/ (fora da sequencia de migrations) de
-- proposito: nesta entrega NENHUM dos 25 titulos historicos pode ser alterado.
-- E material de estudo/proposta para uma reconciliacao futura, a ser revisada e
-- executada manualmente e deliberadamente (a equipe pode preferir re-vincular
-- manualmente alguns titulos ao acordo ATIVO do aluno em vez de reabri-los).
-- Depende da correcao estrutural (A) 20260727235500.
--
-- Populacao alvo (auditada em producao, 25 titulos / 11 alunos / R$47.528,45):
-- titulos com situacao='NEGOCIADO' e status='em_aberto' que NUNCA tiveram linha
-- em acordo_titulo_vinculo (tot_vinc=0). Foram marcados NEGOCIADO por caminho
-- legado, sem ponte de vinculo. NAO sao dividas fantasmas: o valor e saldo REAL
-- do aluno -- apenas classificado incorretamente (rotulado como negociado-orfao,
-- escondido da lista da ficha, porem contado no total). O total do aluno NAO
-- muda com esta reconciliacao; o saldo apenas migra do bucket
-- "titulos_negociados_orfaos" para "titulos_abertos", ficando consistente entre
-- a lista e o total. 24/25 alunos possuem acordo ATIVO; 1 possui ATIVO+CANCELADO;
-- nenhum titulo esta pago.
--
-- Regra (idempotente, sem tocar em pago), identica a da correcao estrutural:
--   a) titulo com vinculo ATIVO valido, nao pago -> NEGOCIADO/vinculada + acordo_id;
--   b) titulo NEGOCIADO sem vinculo ativo valido, nao pago -> ABERTO/em_aberto.

-- a) Alinha titulos que TEM vinculo ativo valido (idempotente).
update public.acordos_titulos t
   set situacao = 'NEGOCIADO', status = 'vinculada',
       acordo_id = sub.acordo_id, atualizado_em = now()
  from (
    select distinct on (v.titulo_id) v.titulo_id, v.acordo_id
      from public.acordo_titulo_vinculo v
      join public.acordos a on a.id = v.acordo_id
     where coalesce(v.ativo, true)
       and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     order by v.titulo_id, v.criado_em desc nulls last
  ) sub
 where t.id = sub.titulo_id
   and upper(coalesce(t.situacao,'')) <> 'PAGO'
   and lower(coalesce(t.status,'')) not in ('quitada','paga')
   and (coalesce(t.situacao,'') <> 'NEGOCIADO'
        or coalesce(t.status,'') <> 'vinculada'
        or t.acordo_id is distinct from sub.acordo_id);

-- b) Reabre (para ABERTO) os NEGOCIADO orfaos, nao pagos (os 25 auditados).
update public.acordos_titulos t
   set situacao = 'ABERTO', status = 'em_aberto',
       acordo_id = null, atualizado_em = now()
 where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
   and lower(coalesce(t.status,'')) not in ('quitada','paga')
   and not exists (
     select 1 from public.acordo_titulo_vinculo v
       join public.acordos a on a.id = v.acordo_id
      where v.titulo_id = t.id
        and coalesce(v.ativo, true)
        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
   );
