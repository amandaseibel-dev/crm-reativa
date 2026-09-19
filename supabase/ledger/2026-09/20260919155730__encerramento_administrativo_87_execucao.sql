-- ENCERRAMENTO ADMINISTRATIVO DOS 87 (19/09/2026) -- EXECUCAO EM PRODUCAO
-- Versoes prod: 20260919155730 (lote 1), 20260919155809 (lote 2), 20260919155835 (lote 3),
-- 20260919155848 (recalculo repetido dos SEM_PENDENCIA). Estrutura: 20260919155544.
-- Universo autorizado: 87 titulos / 43 alunos / R$ 77.472,27 (CANCELAMENTO_ESTORNO 83, ISENCAO_FIES_BOLSA 4).
-- Rota unica: prime_conferencia_encerrar_administrativo, assinada pela gestao (jwt claims).
-- Aluno = unidade indivisivel: revalidacao do aluno inteiro antes (decisao PENDENTE, EM_CONFIRMACAO,
-- classe valida com evidencia, nenhum pagamento/acordo/decisao financeira posterior a classe humana);
-- erro em qualquer titulo desfaz o aluno e registra CONFERENCIA_PRIME_ENCERRAMENTO_ADMINISTRATIVO_BLOQUEADO.
-- Simulacao reversivel identica as 15:43 UTC.
--
-- RESULTADO (fotografia 15:59 UTC):
--   executados 87 (38+27+22) / bloqueados 0
--   titulos: 87 CANCELADA/cancelada, origem_encerramento=CONFERENCIA_PRIME_ADMINISTRATIVA, origem_liquidacao tocada 0
--   decisoes: ENCERRADO_ADMINISTRATIVO 87 (CE 83, FIES 4); pendentes 751 -> 664; classe_humana preservada
--   alunos: SEM_PENDENCIA 22, COBRANCA_VENCIDA 12, ACORDO_EM_DIA 2, AGUARDANDO_CONFIRMACAO 7, QUITADO 0
--   recalcular_situacao_aluno repetido nos 22 SEM_PENDENCIA: 22 permanecem, 0 QUITADO
--   casos: 20 encerrados SEM_SALDO_EM_ABERTO (encerrado_operacional, ZERADO_REAL_SEM_SALDO 21 movs), ativos 41 -> 21
--   quitado_em novo 0, QUITACAO_AUTOMATICA 0, movimentacoes de quitacao 0
--   responsaveis: 33 antes / 33 depois (preservados)
--   saldo exigivel dos alunos 7.004,97 = 7.004,97
--   PAGO 5.220 = 5.220; NEGOCIADO 3.107 = 3.107; pagamentos 9.308 = 9.308; honorario 916.349,26 = 916.349,26
--   recuperacao_historica 21.994 = 21.994; recuperacoes_consolidadas 14.041 = 14.041
--   acordos 4.129 / parcelas 15.340 / vinculos 4.777 / reposicao 280: iguais
--   canceladas 262 -> 349; prime_liquidacao_classificacao LIQUIDACAO_INSTITUCIONAL +87
--
-- Texto executado (um bloco por lote, so muda v_alunos e o numero do lote na observacao):
do $lote$
declare
  v_sub uuid; v_alunos uuid[] := array[/* 15, 15 e 13 alunos, ordenados por id */]::uuid[];
  a uuid; t record; r jsonb; v_n int := 0; v_bloq int := 0;
  v_pag0 int; v_ac0 int; v_parc0 int; v_vinc0 int; v_rep0 int;
begin
  select id into v_sub from auth.users where lower(email) = 'amanda.seibel@aelbra.com.br';
  perform set_config('request.jwt.claims', json_build_object('email','amanda.seibel@aelbra.com.br','role','authenticated','sub',v_sub)::text, true);
  select count(*) into v_pag0 from public.pagamentos; select count(*) into v_ac0 from public.acordos;
  select count(*) into v_parc0 from public.parcelas; select count(*) into v_vinc0 from public.acordo_titulo_vinculo;
  select count(*) into v_rep0 from public.reposicao_carteira_fila;
  foreach a in array v_alunos loop
    begin
      if exists (select 1 from public.prime_conferencia_decisao d join public.acordos_titulos x on x.id = d.titulo_id
                  where d.aluno_id = a and d.classe_humana in ('CANCELAMENTO_ESTORNO','ISENCAO_FIES_BOLSA') and d.decisao = 'PENDENTE'
                    and (upper(x.situacao) <> 'EM_CONFIRMACAO' or coalesce(d.classe_humana_obs,'') = ''
                         or exists (select 1 from public.pagamentos p where p.aluno_id = a and p.created_at > d.classe_humana_em)
                         or exists (select 1 from public.acordos ac where ac.aluno_id = a and ac.criado_em > d.classe_humana_em)
                         or exists (select 1 from public.prime_conferencia_decisao d2 where d2.aluno_id = a and d2.decisao in ('CONFIRMADO','VINCULADO') and d2.decidido_em > d.classe_humana_em))) then
        raise exception 'REVALIDACAO_FALHOU';
      end if;
      for t in select d.titulo_id from public.prime_conferencia_decisao d
                where d.aluno_id = a and d.decisao = 'PENDENTE' and d.classe_humana in ('CANCELAMENTO_ESTORNO','ISENCAO_FIES_BOLSA')
                order by d.documento loop
        r := public.prime_conferencia_encerrar_administrativo(t.titulo_id,
              'Encerramento administrativo 19/09/2026 (lote N): classe humana registrada com evidencia objetiva do Prime; sem pagamento, acordo ou recuperacao.');
        v_n := v_n + 1;
      end loop;
    exception when others then
      v_bloq := v_bloq + 1;
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values ('amanda.seibel@aelbra.com.br', 'CONFERENCIA_PRIME_ENCERRAMENTO_ADMINISTRATIVO_BLOQUEADO', 'alunos', a, jsonb_build_object('lote', N, 'erro', sqlerrm));
    end;
  end loop;
  if (select count(*) from public.pagamentos) <> v_pag0 or (select count(*) from public.acordos) <> v_ac0
     or (select count(*) from public.parcelas) <> v_parc0 or (select count(*) from public.acordo_titulo_vinculo) <> v_vinc0
     or (select count(*) from public.reposicao_carteira_fila) <> v_rep0 then
    raise exception 'TRAVA: efeito financeiro ou reposicao detectado';
  end if;
  if exists (select 1 from public.alunos where id = any(v_alunos) and situacao_operacional like 'QUITADO%')
     or exists (select 1 from public.casos where aluno_id = any(v_alunos) and quitado_em is not null and quitado_em > now() - interval '10 minutes') then
    raise exception 'TRAVA: aluno virou QUITADO';
  end if;
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'CONFERENCIA_PRIME_ENCERRAMENTO_ADMINISTRATIVO_LOTE', 'prime_conferencia_decisao', null,
          jsonb_build_object('lote', N, 'alunos', array_length(v_alunos,1), 'titulos_executados', v_n, 'alunos_bloqueados', v_bloq));
end
$lote$;

-- Recalculo repetido (versao 20260919155848): recalcular_situacao_aluno em cada aluno SEM_PENDENCIA com
-- titulo origem_encerramento; trava se algum virar QUITADO ou a contagem mudar. Resultado 22 -> 22, QUITADO 0
-- (auditoria CONFERENCIA_PRIME_ENCERRAMENTO_ADMINISTRATIVO_RECALC).
