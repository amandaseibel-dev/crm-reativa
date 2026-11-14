// Dublê para EXECUTAR handlers de Edge Function no vitest (só usado por testes).
// Captura o handler de serve(); createClient devolve um cliente em memória
// (JWT do usuário e service role, com rpc); fetch é substituído: cada chamada à
// ULBRA é contada e a resposta é a que o teste escolheu. Sem rede.
export const estado: {
  env: Record<string, string>;
  banco: Record<string, Array<Record<string, unknown>>>;
  handler: ((req: Request) => Promise<Response>) | null;
  tokens: Record<string, string>;
  chamadasUlbra: number;
} = { env: {}, banco: {}, handler: null, tokens: {}, chamadasUlbra: 0 };

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno = {
  env: { get: (k: string) => estado.env[k] },
  serve: (h: (req: Request) => Promise<Response>) => {
    estado.handler = h;
  },
};

export const servePlaceholder = {
  serve: (h: (req: Request) => Promise<Response>) => {
    estado.handler = h;
  },
};

type Filtro = [string, unknown, "eq" | "is" | "not"];

function construirConsulta(tabela: string) {
  const filtros: Filtro[] = [];
  let limite = Infinity;
  const executar = () => {
    const linhas = estado.banco[tabela] ?? [];
    return linhas
      .filter((l) => filtros.every(([c, v, op]) => {
        if (op === "is") return (l[c] ?? null) === null;
        if (op === "not") return (l[c] ?? null) !== null;
        return l[c] === v;
      }))
      .slice(0, limite);
  };
  const q = {
    select() { return q; },
    eq(c: string, v: unknown) { filtros.push([c, v, "eq"]); return q; },
    is(c: string, v: unknown) { filtros.push([c, v, "is"]); return q; },
    not(c: string, _op: string, v: unknown) { if (v === null) filtros.push([c, null, "not"]); return q; },
    limit(n: number) { limite = n; return q; },
    async maybeSingle() { return { data: executar()[0] ?? null, error: null }; },
    async single() {
      const r = executar()[0];
      return r ? { data: r, error: null } : { data: null, error: { message: "nenhuma linha" } };
    },
    update(campos: Record<string, unknown>) {
      return {
        eq: async (c: string, v: unknown) => {
          (estado.banco[tabela] ?? []).filter((l) => l[c] === v).forEach((l) => Object.assign(l, campos));
          return { data: null, error: null };
        },
      };
    },
    async insert(obj: Record<string, unknown>) {
      (estado.banco[tabela] ??= []).push(obj);
      return { data: null, error: null };
    },
    then(resolve: (v: unknown) => void) {
      resolve({ data: executar(), error: null });
    },
  };
  return q;
}

// Mesma regra do ulbra_historico_reservar (SQL), sobre estado.banco.ulbra_historico_uso.
function reservarNoBanco(args: { p_operador: string; p_dia: string; p_quantidade: number; p_teto_operador: number; p_teto_global: number }) {
  const linhas = (estado.banco.ulbra_historico_uso ??= []);
  const pegar = (escopo: string) => {
    let l = linhas.find((x) => x.escopo === escopo && x.dia === args.p_dia);
    if (!l) { l = { escopo, dia: args.p_dia, usadas: 0 }; linhas.push(l); }
    return l;
  };
  const uo = pegar(args.p_operador);
  const ug = pegar("*");
  if (Number(uo.usadas) + args.p_quantidade > args.p_teto_operador || Number(ug.usadas) + args.p_quantidade > args.p_teto_global) {
    return { data: [{ permitido: false, usadas_operador: uo.usadas, usadas_global: ug.usadas }], error: null };
  }
  uo.usadas = Number(uo.usadas) + args.p_quantidade;
  ug.usadas = Number(ug.usadas) + args.p_quantidade;
  return { data: [{ permitido: true, usadas_operador: uo.usadas, usadas_global: ug.usadas }], error: null };
}

export function clienteSupabaseFalso(_url: string, _chave: string, opts?: { global?: { headers?: Record<string, string> } }) {
  const cabecalho = opts?.global?.headers?.Authorization ?? "";
  return {
    auth: {
      getUser: async () => {
        const token = cabecalho.replace(/^Bearer /, "");
        const email = estado.tokens[token];
        return { data: { user: email ? { email } : null }, error: null };
      },
    },
    from: (tabela: string) => construirConsulta(tabela),
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome !== "ulbra_historico_reservar") return { data: null, error: { message: `rpc inesperada: ${nome}` } };
      return reservarNoBanco(args as never);
    },
  };
}

/** Resposta da ULBRA por nome da ferramenta chamada (params.name do JSON-RPC). */
export type Roteamento = Record<string, () => Response>;

export function ulbraRoteada(rotas: Roteamento) {
  estado.chamadasUlbra = 0;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = async (_url: string, init?: { body?: string }) => {
    estado.chamadasUlbra++;
    const nome = JSON.parse(String(init?.body ?? "{}"))?.params?.name as string;
    const rota = rotas[nome];
    if (!rota) throw new Error(`ferramenta sem rota no teste: ${nome}`);
    return rota();
  };
}

/** Envelope JSON-RPC de sucesso com `corpo` como texto da resposta. */
export function envelope(corpo: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(corpo) }] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export const limite429 = (): Response => new Response("limite", { status: 429 });
