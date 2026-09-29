import { Routes } from "@angular/router";
import { LoginGuard } from "src/app/core/guards";

export const signRoutes: Routes = [
    {
        path: '',
        loadComponent: () => import('../../pages/service/signup/signup.component').then(m => m.SignupComponent),
        data: {
            title: 'signup',
            animation: 'signup'
        },
        canActivate: [LoginGuard],
        canActivateChild: [LoginGuard]
    }
];
