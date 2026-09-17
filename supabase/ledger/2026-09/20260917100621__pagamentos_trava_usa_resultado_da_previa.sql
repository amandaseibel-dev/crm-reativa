-- PAGAMENTOS_TRAVA PASSA A USAR O RESULTADO DA PREVIA QUE JA EXECUTA.
--
-- O PROBLEMA (auditoria de 17/09/2026, leitura em producao). Das 27 linhas em
-- que a fila oferecia "Registrar acordo a vista", 12 passavam na simulacao e 15
-- eram recusadas de qualquer jeito:
--   10 por margem, 1 aluno ja encerrado, 1 operador nao cadastrado,
--   2 sem mensalidade elegivel, 1 com a mensalidade maior que o valor pago.
-- A regra da tela e que a acao manual so aparece quando ela e possivel.
--
-- A CAUSA. `pagamentos_trava` ja chama `acordo_avista_previa(id, null)` para
-- cada pagamento -- a mesma previa que protege o registro -- mas so lia dela a
-- identidade e o boleto. `aprovado` e `bloqueios` eram ignorados.
--
-- O AJUSTE. Quando a linha seria ACORDO_AVISTA_AUSENTE e a previa NAO aprova, a
-- trava passa a ser o motivo da recusa, lido de `bloqueios`. Nenhuma validacao e
-- reescrita aqui: margem, soma, elegibilidade, operador e situacao do aluno
-- continuam decididos so pela previa. A funcao nao faz simulacao nova nenhuma.
--
--   ACORDO_AVISTA_ALUNO_ENCERRADO ........... ALUNO_NAO_ENCERRADO
--   ACORDO_AVISTA_OPERADOR_NAO_CADASTRADO ... OPERADOR_CADASTRADO
--   ACORDO_AVISTA_OUTRO_BLOQUEIO ............ qualquer bloqueio que nao dependa
--                                             das mensalidades escolhidas
--   ACORDO_AVISTA_SEM_MENSALIDADE_ELEGIVEL .. TITULOS_ESCOLHIDOS (a sugestao e
--                                             toda mensalidade elegivel: vazia)
--   ACORDO_AVISTA_FORA_DA_MARGEM ............ DIFERENCA_DENTRO_DA_MARGEM_SEGURA
--   ACORDO_AVISTA_SEM_COMBINACAO_SEGURA ..... SOMA_ATE_O_VALOR_PAGO / TITULOS_ELEGIVEIS
--
-- SEM BUSCA DE COMBINACAO MENOR, DE PROPOSITO (decisao da gestao, 17/09/2026).
-- Se a sugestao passa do valor pago, a linha fica SEM_COMBINACAO_SEGURA e sem
-- acao. Nenhum caso real atual exige outra escolha; se aparecer, e melhoria
-- separada.
--
-- O QUE NAO MUDA: assinatura, retorno, portao da gestao, permissoes (create or
-- replace preserva o ACL), a previa, o registro, o motor de baixa, os vinculos,
-- a importacao, o cron, a consulta ao portador e a margem de 1,15. Nenhum dado
-- e escrito.

create or replace function public.pagamentos_trava(p_pagamento_ids uuid[])
 returns table(pagamento_id uuid, trava text, aluno_id uuid, aluno_nome text, numero_ulbra text)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
declare
  v_id uuid;
  v_p jsonb;
  v_ident jsonb;
  v_bloq jsonb;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A fila de pagamentos sem vinculo e da gestao financeira.' using errcode = '42501';
  end if;

  for v_id in
    select distinct x from unnest(coalesce(p_pagamento_ids, '{}'::uuid[])) x where x is not null limit 500
  loop
    v_p := public.acordo_avista_previa(v_id, null);
    v_ident := v_p -> 'identificacao';
    pagamento_id := v_id;
    aluno_id := (v_ident ->> 'aluno_id')::uuid;
    aluno_nome := v_p -> 'aluno' ->> 'nome';
    numero_ulbra := v_p -> 'boleto' ->> 'numero_ulbra';

    trava := case
      when v_p -> 'pagamento' is null or v_p -> 'pagamento' = 'null'::jsonb then 'NAO_ENCONTRADO'
      when coalesce(v_p -> 'pagamento' ->> 'status_conciliacao', '') <> 'AGUARDANDO_ACORDO' then 'FORA_DO_ESCOPO'
      when coalesce((v_p -> 'boleto' ->> 'acordo_ja_existe')::boolean, false) then 'ACORDO_CHEGOU_AGUARDANDO_RODADA'
      when v_ident ->> 'aluno_id' is not null then
        case when coalesce((v_p -> 'boleto' ->> 'no_padrao')::boolean, false)
                  and v_p -> 'boleto' ->> 'parcela' = '0001'
                  and coalesce((v_p -> 'boleto' ->> 'unico_do_acordo')::boolean, false)
             then case when v_p -> 'boleto' -> 'evidencia_existia_antes' is not null
                            and v_p -> 'boleto' -> 'evidencia_existia_antes' <> 'null'::jsonb
                       then 'ACORDO_AVISTA_AUSENCIA_NAO_EXPLICADA'
                       else 'ACORDO_AVISTA_AUSENTE' end
             else 'ACORDO_PARCELADO_AUSENTE' end
      when v_ident ->> 'aluno_no_pagamento' is not null then 'ALUNO_VINCULADO_SEM_PROVA_DUPLA'
      when (v_ident ->> 'alunos_por_matricula')::int = 1 and (v_ident ->> 'alunos_por_nome')::int = 1
        then 'IDENTIDADE_DIVERGENTE'
      else 'ALUNO_NAO_IDENTIFICADO'
    end;

    -- A acao so existe quando a previa aprova. Recusada, a trava diz o motivo
    -- que a propria previa deu -- a ordem poe primeiro o que nao depende das
    -- mensalidades escolhidas.
    if trava = 'ACORDO_AVISTA_AUSENTE' and not coalesce((v_p ->> 'aprovado')::boolean, false) then
      v_bloq := coalesce(v_p -> 'bloqueios', '[]'::jsonb);
      trava := case
        when v_bloq ? 'ALUNO_NAO_ENCERRADO' then 'ACORDO_AVISTA_ALUNO_ENCERRADO'
        when v_bloq ? 'OPERADOR_CADASTRADO' then 'ACORDO_AVISTA_OPERADOR_NAO_CADASTRADO'
        when exists (select 1 from jsonb_array_elements_text(v_bloq) b(codigo)
                      where b.codigo not in ('TITULOS_ESCOLHIDOS', 'TITULOS_ELEGIVEIS',
                                             'SOMA_ATE_O_VALOR_PAGO', 'DIFERENCA_DENTRO_DA_MARGEM_SEGURA'))
          then 'ACORDO_AVISTA_OUTRO_BLOQUEIO'
        when v_bloq ? 'TITULOS_ESCOLHIDOS' then 'ACORDO_AVISTA_SEM_MENSALIDADE_ELEGIVEL'
        when v_bloq ? 'DIFERENCA_DENTRO_DA_MARGEM_SEGURA' then 'ACORDO_AVISTA_FORA_DA_MARGEM'
        when v_bloq ?| array['SOMA_ATE_O_VALOR_PAGO', 'TITULOS_ELEGIVEIS'] then 'ACORDO_AVISTA_SEM_COMBINACAO_SEGURA'
        else 'ACORDO_AVISTA_OUTRO_BLOQUEIO'
      end;
    end if;
    return next;
  end loop;
end;
$fn$;

comment on function public.pagamentos_trava(uuid[]) is
  'Diz, para cada pagamento, o ponto exato em que a conciliacao travou (identidade, estrutura do acordo, rodada). Para o acordo a vista ausente, so devolve ACORDO_AVISTA_AUSENTE quando a previa do registro aprova; recusada, devolve o motivo da propria previa. A tela so oferece a acao que corresponde a esse ponto. Gestao apenas; sem DML.';

do $prova$
declare
  v_oid oid;
  v_src text;
begin
  -- mesma assinatura, uma sobrecarga so
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'pagamentos_trava') <> 1 then
    raise exception 'pagamentos_trava ganhou sobrecarga';
  end if;
  v_oid := 'public.pagamentos_trava(uuid[])'::regprocedure;
  if pg_get_function_result(v_oid) <> 'TABLE(pagamento_id uuid, trava text, aluno_id uuid, aluno_nome text, numero_ulbra text)' then
    raise exception 'pagamentos_trava mudou o retorno';
  end if;

  -- permissoes como estavam: authenticated chama (o portao e interno), anon e PUBLIC nao
  if not has_function_privilege('authenticated', v_oid, 'EXECUTE')
     or has_function_privilege('anon', v_oid, 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                 where p.oid = v_oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'pagamentos_trava mudou de permissao';
  end if;

  -- continua so leitura, atras do portao, e decidindo pela previa
  select p.prosrc into v_src from pg_proc p where p.oid = v_oid;
  if v_src ~* '\m(insert|update|delete)\M' then
    raise exception 'pagamentos_trava passou a escrever';
  end if;
  if position('usuario_e_gestao' in v_src) = 0
     or position('usuario_e_gestao' in v_src) > position('public.acordo_avista_previa(' in v_src) then
    raise exception 'o portao da gestao deixou de vir antes da previa';
  end if;
  if position('''aprovado''' in v_src) = 0 or position('''bloqueios''' in v_src) = 0 then
    raise exception 'pagamentos_trava deixou de ler o resultado da previa';
  end if;
end $prova$;
