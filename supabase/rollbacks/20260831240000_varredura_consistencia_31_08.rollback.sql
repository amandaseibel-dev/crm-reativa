-- DESFAZER 20260831240000_varredura_consistencia_31_08.sql
--
-- Volta os dois titulos da Josidelma para NEGOCIADO (rotulo sem vinculo, que era
-- o estado incoerente) e a parcela do acordo quitado do Lucas para nao paga.
-- Nenhum dos dois muda saldo -- nao mudou ao aplicar, nao muda ao desfazer.

update public.acordos_titulos t
   set situacao = b.situacao, status = b.status,
       motivo_ajuste = b.motivo_ajuste, atualizado_em = now()
  from public._backup_varredura_31_08 b
 where t.id = b.id;

update public.parcelas p
   set status = b.status, atualizado_em = now()
  from public._backup_varredura_parcelas_31_08 b
 where p.id = b.id;
