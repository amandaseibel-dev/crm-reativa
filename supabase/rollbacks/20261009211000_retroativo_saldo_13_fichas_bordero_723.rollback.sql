-- ROLLBACK de 20261009211000_retroativo_saldo_13_fichas_bordero_723.sql
--
-- O ajuste so preencheu campos DERIVADOS (saldo_total, saldo_vencido,
-- situacao_operacional, nivel_criticidade, proxima_acao, data_retorno,
-- retorno_origem) de 13 alunos que os tinham nulos. Nada financeiro foi
-- escrito, entao nao ha o que restaurar de divida.
--
-- Voltar ao estado anterior = devolver esses campos a nulo nos MESMOS 13.
-- A regra de selecao e a mesma da ida, acrescida da marca que o recalculo
-- deixou: `retorno_origem = 'AUTOMATICO'` com o lote no historico.
--
-- ATENCAO: so faz sentido rodar logo depois da ida. Se um operador tabular um
-- desses alunos no meio, o campo deixa de ser derivado e volta a ser decisao
-- humana -- por isso o portao abaixo recusa quem ja tem acionamento.

do $$
declare v_ids uuid[]; v_qtd int;
begin
  select array_agg(a.id) into v_ids
    from public.alunos a
   where regexp_replace(coalesce(a.cpf,''),'\D','','g') in (
           select distinct regexp_replace(coalesce(b.cpf,''),'\D','','g')
             from public._backup_alunos_dup_bordero723_20261009 b
            where coalesce(btrim(b.cpf),'') <> '')
     and a.situacao_operacional = 'COBRANCA_VENCIDA'
     and a.saldo_total is not null
     and a.data_ultimo_acionamento is null
     and not exists (select 1 from public.casos c where c.aluno_id = a.id);

  v_qtd := coalesce(cardinality(v_ids),0);
  if v_qtd <> 13 then
    raise exception 'ROLLBACK ABORTADO: a regra achou % alunos, nao 13. Confira a mao.', v_qtd;
  end if;

  update public.alunos set
     saldo_total          = null,
     saldo_vencido        = null,
     situacao_operacional = null,
     nivel_criticidade    = null,
     proxima_acao         = null,
     data_retorno         = null,
     retorno_origem       = null
   where id = any (v_ids);

  select count(*) into v_qtd from public.alunos where id = any (v_ids) and saldo_total is not null;
  if v_qtd <> 0 then
    raise exception 'ROLLBACK INCOMPLETO: % ainda com saldo.', v_qtd;
  end if;
end $$;
