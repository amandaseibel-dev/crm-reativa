-- NAO APLICAR sem autorizacao expressa da Amanda. Depende de
-- 20261009210000_recalculo_de_saldo_por_titulo.sql (fila + dreno).
--
-- AJUSTE RETROATIVO dos 13 alunos do bordero 723 que ficaram com
-- `alunos.saldo_total` NULO carregando R$ 79.856,84 em titulos abertos.
-- Causa e analise em 20261009210000 e em
-- docs/RECALCULO-SALDO-POR-TITULO-2026-10-09.md.
--
-- SEM DADO PESSOAL (repositorio publico, §7 da premissa de seguranca): os
-- alunos entram pela REGRA, nao por lista de id -- "ficha unica do CPF que
-- esta no backup do bordero 723, com titulo cobravel e saldo nulo". Nenhum CPF
-- e nome aparece aqui.
--
-- O QUE ESTE AJUSTE FAZ: enfileira os 13 e chama o dreno, que chama
-- `recalcular_situacao_aluno`. Nada mais. A funcao canonica escreve em `casos`
-- e `alunos` -- criticidade, situacao_operacional, proxima_acao, saldo_vencido,
-- saldo_total, data_retorno, retorno_origem.
--
-- O QUE ELE NAO FAZ, e os portoes provam: nao cria nem altera titulo, acordo,
-- parcela, pagamento, baixa, movimentacao nem solicitacao; nao troca
-- responsavel; nao mexe em caso (os 13 nao tem caso).
--
-- REFLEXO PROJETADO (leitura em producao, 09/10/2026, antes de aplicar):
--   13 alunos, saldo_total projetado R$ 79.856,84, saldo_vencido idem
--   (todos os titulos ja vencidos) -> os 13 viriam para COBRANCA_VENCIDA
--   0 casos afetados          (nenhum dos 13 tem caso)
--   0 abaixo do minimo de fila (R$ 5,00) -- nenhum e escondido por residuo
--   0 em carteira_operador     -> nenhuma carteira muda de tamanho
--   0 ja tinham situacao_operacional ou data_retorno -> o ajuste so ACRESCENTA
--     informacao; nada e deslocado de fila nem sobrescrito

do $$
declare
  v_ids uuid[];
  v_qtd int;
  v_valor numeric;
  v_titulos_antes int; v_valor_titulos_antes numeric;
  v_pag_antes int; v_acordos_antes int; v_mov_antes int; v_casos_antes int;
  v_res jsonb;
begin
  if to_regclass('public.recalculo_saldo_pendente') is null then
    raise exception 'ABORTADO: aplique 20261009210000_recalculo_de_saldo_por_titulo.sql primeiro.';
  end if;

  -- Os 13, pela regra. CPF nunca escrito: vem do backup do bordero 723.
  select array_agg(a.id) into v_ids
    from public.alunos a
   where regexp_replace(coalesce(a.cpf,''),'\D','','g') in (
           select distinct regexp_replace(coalesce(b.cpf,''),'\D','','g')
             from public._backup_alunos_dup_bordero723_20261009 b
            where coalesce(btrim(b.cpf),'') <> '')
     and a.saldo_total is null
     and exists (
       select 1 from public.acordos_titulos t
        where t.aluno_id::text = a.id::text
          and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
          and coalesce(lower(t.status),'') not in ('quitada')
          and coalesce(t.tipo_boleto,'') <> 'Acordo');

  v_qtd := coalesce(cardinality(v_ids), 0);
  if v_qtd <> 13 then
    raise exception 'ABORTADO: a regra achou % alunos, nao 13. Refaca o censo.', v_qtd;
  end if;

  -- 1) retrato financeiro ANTES
  select count(*), coalesce(sum(valor_original),0) into v_titulos_antes, v_valor_titulos_antes
    from public.acordos_titulos where aluno_id::text = any (select unnest(v_ids)::text);
  select count(*) into v_pag_antes from public.pagamentos where aluno_id::text = any (select unnest(v_ids)::text);
  select count(*) into v_acordos_antes from public.acordos where aluno_id::text = any (select unnest(v_ids)::text);
  select count(*) into v_mov_antes from public.aluno_movimentacoes where aluno_id::text = any (select unnest(v_ids)::text);
  select count(*) into v_casos_antes from public.casos where aluno_id = any (v_ids);

  if v_casos_antes <> 0 then
    raise exception 'ABORTADO: % dos 13 tem caso. O reflexo em fila precisa de nova analise.', v_casos_antes;
  end if;

  -- 2) enfileira e drena SO estes 13
  insert into public.recalculo_saldo_pendente (aluno_id, origem)
  select unnest(v_ids), 'retroativo_bordero723_20261009'
  on conflict (aluno_id) do nothing;

  select set_config('request.jwt.claims','{"role":"service_role"}',true);
  select public.recalculo_saldo_pendente_processar(13, 'retroativo_bordero723_20261009') into v_res;

  if (v_res->>'processados')::int <> 13 or (v_res->>'com_erro')::int <> 0 then
    raise exception 'ABORTADO: dreno devolveu %. Esperado 13 processados e 0 erros.', v_res;
  end if;

  -- 3) PORTAO: a divida nao se moveu
  select count(*), coalesce(sum(valor_original),0) into v_qtd, v_valor
    from public.acordos_titulos where aluno_id::text = any (select unnest(v_ids)::text);
  if v_qtd <> v_titulos_antes or v_valor is distinct from v_valor_titulos_antes then
    raise exception 'ABORTADO: titulos eram %/% e viraram %/%.',
      v_titulos_antes, v_valor_titulos_antes, v_qtd, v_valor;
  end if;

  select count(*) into v_qtd from public.pagamentos where aluno_id::text = any (select unnest(v_ids)::text);
  if v_qtd <> v_pag_antes then raise exception 'ABORTADO: pagamentos eram % e viraram %.', v_pag_antes, v_qtd; end if;

  select count(*) into v_qtd from public.acordos where aluno_id::text = any (select unnest(v_ids)::text);
  if v_qtd <> v_acordos_antes then raise exception 'ABORTADO: acordos eram % e viraram %.', v_acordos_antes, v_qtd; end if;

  select count(*) into v_qtd from public.aluno_movimentacoes where aluno_id::text = any (select unnest(v_ids)::text);
  if v_qtd <> v_mov_antes then raise exception 'ABORTADO: movimentacoes eram % e viraram %.', v_mov_antes, v_qtd; end if;

  select count(*) into v_qtd from public.casos where aluno_id = any (v_ids);
  if v_qtd <> 0 then raise exception 'ABORTADO: apareceram % casos. Nao era para criar caso.', v_qtd; end if;

  -- 4) CONFERENCIA: o saldo passou a existir e bate com os titulos
  select count(*) into v_qtd from public.alunos where id = any (v_ids) and saldo_total is null;
  if v_qtd <> 0 then raise exception 'ABORTADO: % dos 13 continuam com saldo nulo.', v_qtd; end if;

  select coalesce(sum(saldo_total),0) into v_valor from public.alunos where id = any (v_ids);
  if v_valor is distinct from 79856.84 then
    raise exception 'ABORTADO: saldo somado ficou % (esperado 79856.84).', v_valor;
  end if;

  select count(*) into v_qtd from public.recalculo_saldo_pendente where aluno_id = any (v_ids);
  if v_qtd <> 0 then raise exception 'ABORTADO: % dos 13 ficaram na fila.', v_qtd; end if;

  raise notice 'OK: 13 alunos recalculados, saldo somado 79856.84, divida intocada.';
end $$;
