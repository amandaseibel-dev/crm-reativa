// Quem está em qual portador da Ulbra.
//
// POR QUE ISSO IMPORTA. A regra de leitura da dívida, dita pela Amanda em
// 25/08/2026, é a mais simples que existe -- e não depende de adivinhar padrão
// de pagamento:
//
//     está no 195 (REATIVA RECUPERAÇÃO)  -> mensalidade em cobrança, AINDA DEVE
//     está no 166 (SANTANDER REATIVA)    -> negociou, virou ACORDO
//     não está em nenhum dos dois        -> QUITOU
//
// Com as duas listas na mão, um título que o CRM cobra e cujo dono não está em
// portador nenhum é dívida paga que ficou aberta aqui. Sem elas, sobra
// heurística de datas -- que erra.
//
// Antes desta função só existia a lista do 166, trazida de alguma sessão
// anterior. Faltava o 195, e é ele que separa "ainda deve" de "quitou".
//
// COMO FUNCIONA. A API pagina com skip/take. A Edge Function morre em 150s,
// então a varredura guarda onde parou em `prime_sync_cursor` e continua na
// invocação seguinte. Chamar de novo até `concluido: true` é o modo de uso.
//
// A lista só cresce durante a varredura; a limpeza do que saiu do portador é
// feita no fim do ciclo, comparando pelo carimbo de tempo -- assim ninguém
// fica sem lista no meio do caminho.
//
// MODO PONTUAL (14/09/2026). Além da varredura, aceita UM caso:
//
//     { registration: "2026003712", pagamento_id: "..." }   ou
//     { cpf: "01520322070",         pagamento_id: "..." }
//
// Existe porque o espelho é varredura semanal e perde o acordo da semana
// corrente: medido em 14/09, um dos divergentes está no 166 ao vivo e NÃO está
// no espelho coletado em 12/09. Duas chamadas resolvem um caso, sem varrer os
// 26.797 do portador.
//
// A confirmação ao vivo GRAVA no espelho -- então o próximo caso do mesmo aluno
// já se resolve localmente, sem chamada externa.
//
// AUSÊNCIA NÃO É PROVA NEGATIVA: não achar no 166 devolve `no166: false` e nada
// mais. Nunca conclui que não houve acordo.
//
// ORDEM DA DECISÃO (15/09/2026). Confirmar o portador 166 prova que houve
// negociação -- não prova que a estrutura do acordo não existe. Então a
// tentativa oficial vem ANTES do fallback:
//
//     1. identidade pela registration/CPF
//     2. GET /students/{registration}/agreements   <- a tentativa oficial
//     3. veio estrutura?  -> ENCONTRADA, ACORDO_ENCONTRADO_NA_API com o payload cru
//     4. falhou?          -> ERRO, e PARA AQUI -- o 166 não é consultado
//     5. veio vazio?      -> NAO_ENCONTRADA, aí sim confirma o 166
//     6. 166 positivo     -> o motor decide o fallback
//
// E o RESULTADO dos passos 3/4/5 é gravado em
// `fila_pagamento_sem_vinculo.consulta_estrutura_resultado`. Isso não é
// redundante com `consulta_portador_em`: aquela coluna é carimbada pelo
// disparador ANTES da chamada e significa apenas TENTATIVA -- ela não sabe
// dizer se a API respondeu "não tenho" ou se caiu. Só NAO_ENCONTRADA abre o
// fallback; ENCONTRADA, ERRO e NULL nunca abrem.
//
// O passo 3 NÃO mapeia campo nenhum para `acordos`/`parcelas`. Devolve o que
// chegou e grava em `auditoria`, porque nunca vimos um payload não vazio -- e
// desenhar a captura sem ele seria inventar o mapeamento. Medido em 59 alunos
// do portador 166 e nos 13 divergentes: `agreements` respondeu 200 com lista
// vazia em 100% dos casos. Se um dia vier, fica registrado para desenhar em
// cima do real.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BASE = "https://prime-api.ulbra.ai/api";
const TAKE = 200;

// Margem para o teto de 150s da Edge: para de buscar aos 110s e devolve o
// cursor. Melhor voltar são e continuar do que morrer em 504 sem gravar nada.
const LIMITE_MS = 110_000;

const digitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");
// Inventário de campos do que chegou -- nomes e tipos, sem mapear para nada.
// Existe para que, no dia em que a API devolver um acordo, a gente desenhe a
// captura em cima da forma REAL e não da documentada.
function inventario(v: unknown, prefixo = "", acc: Record<string, string> = {}, prof = 0) {
  if (prof > 4 || v === null || v === undefined) return acc;
  if (Array.isArray(v)) {
    if (v.length) inventario(v[0], prefixo + "[]", acc, prof + 1);
    return acc;
  }
  if (typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const cam = prefixo ? `${prefixo}.${k}` : k;
      acc[cam] = Array.isArray(val) ? `array(${val.length})` : (val === null ? "null" : typeof val);
      inventario(val, cam, acc, prof + 1);
    }
  }
  return acc;
}

const formataCpf = (c: string) =>
  c.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : c;

async function primeGet(caminho: string, chave: string) {
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    try {
      const r = await fetch(BASE + caminho, { headers: { "X-API-Key": chave } });
      // 503 = indisponibilidade temporária do banco da Prime.
      if (r.status === 503) { await new Promise((s) => setTimeout(s, 1500 * (tentativa + 1))); continue; }
      if (!r.ok) return { ok: false as const, status: r.status };
      return { ok: true as const, dados: await r.json() };
    } catch {
      await new Promise((s) => setTimeout(s, 1200 * (tentativa + 1)));
    }
  }
  return { ok: false as const, status: 0 };
}

Deno.serve(async (req) => {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Mesmo portão da prime-cadastro: token da rotina no Vault, ou sessão de
  // gestão. A função roda com verify_jwt = false e decide sozinha quem entra.
  const tokenRecebido = req.headers.get("x-rotina-token") ?? "";
  let ehRotina = false;
  if (tokenRecebido) {
    const { data } = await supa.rpc("prime_cadastro_token_valido", { p_token: tokenRecebido });
    ehRotina = data === true;
  }

  if (!ehRotina) {
    const autorizacao = req.headers.get("Authorization") ?? "";
    if (!autorizacao.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ erro: "SEM_TOKEN" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    const supaChamador = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: autorizacao } } },
    );
    const { data: ehGestao } = await supaChamador.rpc("usuario_e_gestao");
    if (ehGestao !== true) {
      return new Response(JSON.stringify({ erro: "ACESSO_NEGADO", detalhe: "restrito a gestao" }), {
        status: 403, headers: { "Content-Type": "application/json" },
      });
    }
  }

  let chave = Deno.env.get("PRIME_API_KEY") ?? "";
  if (!chave) {
    const { data } = await supa.rpc("prime_api_key_backend");
    chave = typeof data === "string" ? data : "";
  }
  if (!chave) {
    return new Response(JSON.stringify({ erro: "PRIME_API_KEY_AUSENTE" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  let corpo: any = {};
  try { corpo = await req.json(); } catch { /* usa os padrões */ }

  // -------------------------------------------------------------------------
  // MODO PONTUAL. Sai antes da varredura -- aqui nunca se varre a base inteira.
  // -------------------------------------------------------------------------
  const registration = String(corpo?.registration ?? "").trim();
  const cpfPedido = digitos(corpo?.cpf);
  if (registration || cpfPedido) {
    let cpf = cpfPedido;
    let nome: string | null = null;

    // 1) registration -> CPF. A matrícula do arquivo Santander É a registration
    //    do Prime -- conferido em 13 de 13 divergentes em 14/09/2026.
    if (!cpf && registration) {
      const r = await primeGet(`/students/${encodeURIComponent(registration)}`, chave);
      if (!r.ok) {
        return new Response(JSON.stringify({ erro: "PRIME_FALHOU", status: r.status, registration }),
          { status: 502, headers: { "Content-Type": "application/json" } });
      }
      const rd = (r.dados as any)?.registrationData ?? {};
      cpf = digitos(rd?.cpf);
      nome = rd?.fullName ?? null;
    }
    if (cpf.length !== 11) {
      return new Response(JSON.stringify({ erro: "CPF_NAO_RESOLVIDO", registration }),
        { status: 422, headers: { "Content-Type": "application/json" } });
    }

    // 2) TENTATIVA OFICIAL, antes de qualquer fallback: o acordo está na API?
    //
    // O QUE SE GRAVA AQUI É O RESULTADO, NÃO A TENTATIVA. `consulta_portador_em`
    // é carimbada pelo disparador ANTES da chamada -- ela só serve para não
    // repetir o mesmo caso de hora em hora, e não sabe distinguir "perguntei e
    // não tinha" de "perguntei e deu erro". Quem decide o fallback é
    // `consulta_estrutura_resultado`, escrito abaixo, depois da resposta:
    //
    //     lista vazia          -> NAO_ENCONTRADA  (segue para o 166)
    //     lista com item       -> ENCONTRADA      (para aqui, payload em auditoria)
    //     4xx/5xx/timeout/JSON -> ERRO            (para aqui, tenta de novo em 24h)
    //     forma desconhecida   -> ERRO            (200, mas ilegível: não é "vazio")
    const tituloNumero = String(corpo?.titulo_numero ?? "").replace(/\D/g, "").replace(/^0+/, "");
    const pagamentoId = String(corpo?.pagamento_id ?? "").trim() || null;
    let estrutura: Record<string, unknown> | null = null;
    const tentadas: string[] = [];

    // O recorder é uma RPC, não um UPDATE: ela valida o valor e é a única
    // superfície de escrita desta coluna. Falha ao gravar não pode inventar
    // resultado -- sem gravação, a coluna fica NULL e NULL nunca promove.
    const registraResultado = async (resultado: "NAO_ENCONTRADA" | "ENCONTRADA" | "ERRO") => {
      if (!pagamentoId) return;
      await supa.rpc("conciliacao_registrar_consulta_estrutura", {
        p_pagamento_id: pagamentoId, p_resultado: resultado,
      });
    };

    if (registration) {
      tentadas.push(registration);
      const a = await primeGet(`/students/${encodeURIComponent(registration)}/agreements`, chave);

      // ERRO: a API não respondeu, ou respondeu o que não dá para ler.
      // `primeGet` já colapsa 4xx/5xx, timeout, exceção de rede e JSON inválido
      // em `ok: false` -- todos são a mesma coisa aqui: não se sabe nada.
      // NÃO SE CONSULTA O 166 NESTA EXECUÇÃO. Perguntar o portador agora seria
      // trocar "não sei se existe estrutura" por "está negociado", que é
      // exatamente o fallback que não pode acontecer sem resposta da API.
      if (!a.ok) {
        await registraResultado("ERRO");
        return new Response(JSON.stringify({
          modo: "pontual", resultado: "ERRO_NA_CONSULTA_DE_ESTRUTURA",
          registration, nome, cpf, status: a.status,
          observacao: "a consulta oficial a /agreements falhou -- 166 nao consultado, caso permanece AGUARDANDO_ACORDO e sera retentado apos 24h",
        }), { status: 502, headers: { "Content-Type": "application/json" } });
      }

      // FORMA DESCONHECIDA TAMBÉM É ERRO, não "zero itens". A Prime responde
      // sempre `{items:[],totalItems:0}`; se um dia vier outra coisa -- um
      // objeto sem `items`, `null`, um número -- não se sabe o que ela disse, e
      // "não sei" nunca pode ser lido como "não tem".
      const d: any = a.dados;
      const itens: any[] | null = Array.isArray(d?.items) ? d.items
        : (Array.isArray(d) ? d : null);
      if (itens === null) {
        await registraResultado("ERRO");
        return new Response(JSON.stringify({
          modo: "pontual", resultado: "ERRO_NA_CONSULTA_DE_ESTRUTURA",
          registration, nome, cpf, status: 200,
          observacao: "/agreements respondeu num formato desconhecido -- 166 nao consultado, nao se conclui ausencia de estrutura a partir de resposta ilegivel",
        }), { status: 502, headers: { "Content-Type": "application/json" } });
      }

      if (itens.length > 0) {
        const cru = JSON.stringify(d);
        estrutura = {
          registration,
          total: d?.totalItems ?? itens.length,
          // o payload CRU, sem mapear: é o artefato que falta para desenhar a captura
          itens_brutos: itens,
          campos_detectados: inventario(itens[0]),
          tem_newInstallments: cru.includes("newInstallments"),
          // compatibilidade com o titulo do Santander: reportada, nunca usada para mapear
          bate_titulo_numero: tituloNumero ? cru.includes(tituloNumero) : null,
        };
        await registraResultado("ENCONTRADA");
      } else {
        // A API respondeu, e respondeu "não tenho". É a única resposta que
        // autoriza, mais adiante, dizer que o acordo existe sem estrutura.
        await registraResultado("NAO_ENCONTRADA");
      }
    }

    // 3) veio estrutura -> NÃO é caso de fallback. Grava o payload real e devolve.
    if (estrutura) {
      await supa.from("auditoria").insert({
        usuario: "rotina",
        acao: "ACORDO_ENCONTRADO_NA_API",
        tabela_afetada: "pagamentos",
        registro_id: pagamentoId,
        detalhes: { cpf, titulo_numero: tituloNumero || null, estrutura },
      });
      return new Response(JSON.stringify({
        modo: "pontual", resultado: "ACORDO_ENCONTRADO_NA_API",
        registration: registration || null, nome, cpf, estrutura,
        observacao: "estrutura oficial encontrada -- captura para acordos/parcelas ainda nao implementada, payload gravado em auditoria",
      }), { headers: { "Content-Type": "application/json" } });
    }

    // 4) veio vazio, como em 100% dos casos medidos -> aí sim confirma o 166
    const b = await primeGet(
      `/students?search=${encodeURIComponent(formataCpf(cpf))}&carrierId=166&take=50`, chave);
    if (!b.ok) {
      return new Response(JSON.stringify({ erro: "PRIME_FALHOU", status: b.status, etapa: "busca166" }),
        { status: 502, headers: { "Content-Type": "application/json" } });
    }
    const achados: any[] = Array.isArray((b.dados as any)?.items) ? (b.dados as any).items : [];

    // `search` É SUBSTRING. Pedir 046.176.770-89 pode trazer linhas de OUTRAS
    // pessoas cujo CPF contenha o trecho -- e aceitar `items.length > 0` seria
    // confirmar negociação de quem não é o titular. Só conta linha cujo CPF é
    // exatamente o mesmo, e as registrations saem apenas dessas linhas.
    const doCpf = achados.filter((i) => digitos(i?.cpf) === cpf);
    const registrations = [...new Set(doCpf.map((i) => i?.registration).filter(Boolean))];
    const no166 = doCpf.length > 0;

    // Quando a registration veio do arquivo, ela deveria estar entre as do CPF
    // no 166. Não estar não invalida a evidência -- o mesmo CPF pode ter outra
    // matrícula no portador -- mas é divergência e vai registrada.
    const registrationConfere = registration
      ? registrations.includes(registration)
      : null;

    // 3) confirmado ao vivo alimenta o espelho -- o próximo cai no caminho local.
    //    Usa o ciclo corrente: gravar com ciclo menor faria a próxima varredura
    //    apagar justamente a linha que acabou de ser confirmada.
    if (no166) {
      const { data: cur } = await supa.from("prime_sync_cursor")
        .select("ciclo").eq("carrier_id", 166).maybeSingle();
      await supa.from("prime_portador_membro").upsert(
        [{ cpf, portador: 166, ciclo: Number(cur?.ciclo) || 1, coletado_em: new Date().toISOString() }],
        { onConflict: "cpf,portador" },
      );
    }

    // 4) e o motor único decide. Identidade só por CPF, dentro da RPC.
    let conciliacao: unknown = null;
    if (pagamentoId && no166) {
      const { data, error } = await supa.rpc("conciliacao_confirmar_portador_166", {
        p_pagamento_id: pagamentoId, p_cpf: cpf, p_origem: "PRIME_API_LIVE",
      });
      conciliacao = error ? { erro: error.message } : data;
    }

    return new Response(JSON.stringify({
      modo: "pontual", resultado: no166 ? "NEGOCIACAO_CONFIRMADA_SEM_ESTRUTURA" : "NADA_CONCLUSIVO",
      registration: registration || null, nome, cpf,
      agreements_tentadas: tentadas, agreements_vazio: true,
      no166, registrations_no_166: registrations,
      registration_confere: registrationConfere,
      linhas_recebidas: achados.length, linhas_do_cpf: doCpf.length,
      conciliacao,
      observacao: no166 ? null : "ausencia no 166 e inconclusiva, nao e prova negativa",
    }), { headers: { "Content-Type": "application/json" } });
  }

  const portador = Number(corpo?.portador) || 195;
  const reiniciar = corpo?.reiniciar === true;

  // De onde continuar. `ciclo` marca a rodada: o que ficou com carimbo de
  // ciclo anterior saiu do portador e é removido quando a varredura fecha.
  // ONDE CONTINUAR E EM QUE RODADA.
  //
  // `ciclo` e um INTEIRO na tabela de cursor -- gravar uma data ali falha em
  // silencio (foi o que aconteceu na primeira versao: a varredura recomecava
  // do zero a cada chamada, sem ninguem perceber). A rodada so avanca quando a
  // varredura comeca do inicio; continuando de onde parou, mantem o numero.
  const { data: cursor } = await supa
    .from("prime_sync_cursor")
    .select("proximo_skip, ciclo")
    .eq("carrier_id", portador)
    .maybeSingle();

  const cicloAnterior = Number(cursor?.ciclo) || 0;
  let skip = reiniciar ? 0 : Number(cursor?.proximo_skip) || 0;
  const ciclo = skip > 0 ? cicloAnterior : cicloAnterior + 1;

  const inicio = Date.now();
  let gravados = 0;
  let paginas = 0;
  let total = 0;
  let concluido = false;

  while (Date.now() - inicio < LIMITE_MS) {
    const r = await primeGet(`/students?carrierId=${portador}&take=${TAKE}&skip=${skip}`, chave);
    if (!r.ok) {
      return new Response(JSON.stringify({
        erro: "BUSCA_FALHOU", status: r.status, portador, skip, gravados, paginas,
      }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    const itens: any[] = Array.isArray(r.dados?.items) ? r.dados.items : [];
    total = Number(r.dados?.totalItems) || total;
    paginas += 1;

    // DEDUPE DENTRO DA PAGINA. O mesmo CPF vem mais de uma vez quando o aluno
    // tem mais de uma matricula no portador, e o upsert recusa a linha
    // repetida ("ON CONFLICT DO UPDATE command cannot affect row a second
    // time") -- derrubando a pagina inteira por causa de um repetido.
    const cpfsDaPagina = new Set<string>();
    for (const i of itens) {
      const c = digitos(i?.cpf);
      if (c.length === 11) cpfsDaPagina.add(c);
    }
    const agora = new Date().toISOString();
    const linhas = [...cpfsDaPagina].map((cpf) => ({ cpf, portador, ciclo, coletado_em: agora }));

    if (linhas.length) {
      const { error } = await supa
        .from("prime_portador_membro")
        .upsert(linhas, { onConflict: "cpf,portador" });
      if (error) {
        return new Response(JSON.stringify({ erro: "GRAVACAO_FALHOU", detalhe: error.message }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
      gravados += linhas.length;
    }

    skip += TAKE;
    if (itens.length < TAKE || (total && skip >= total)) { concluido = true; break; }
  }

  // O erro do cursor NAO pode passar batido: sem cursor gravado, a proxima
  // chamada recomeca do zero e a varredura nunca termina.
  const { error: erroCursor } = await supa.from("prime_sync_cursor").upsert({
    carrier_id: portador,
    proximo_skip: concluido ? 0 : skip,
    total_itens: total,
    ciclo,
    atualizado_em: new Date().toISOString(),
  }, { onConflict: "carrier_id" });
  if (erroCursor) {
    return new Response(JSON.stringify({
      erro: "CURSOR_FALHOU", detalhe: erroCursor.message, portador, skip, gravados,
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  // Fim do ciclo: quem não foi recarimbado saiu do portador. A limpeza só
  // acontece aqui, com a lista inteira já reescrita -- no meio da varredura,
  // apagar deixaria a regra de leitura cega.
  let removidos = 0;
  if (concluido) {
    const { data, error } = await supa
      .from("prime_portador_membro")
      .delete()
      .eq("portador", portador)
      .lt("ciclo", ciclo)
      .select("cpf");
    if (!error) removidos = (data ?? []).length;
  }

  return new Response(JSON.stringify({
    portador, concluido, paginas, gravados, removidos,
    total_na_prime: total, proximo_skip: concluido ? 0 : skip,
    segundos: Math.round((Date.now() - inicio) / 1000),
  }), { headers: { "Content-Type": "application/json" } });
});
